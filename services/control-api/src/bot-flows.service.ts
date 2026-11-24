import { createHash, randomBytes, randomUUID } from "node:crypto";
import {assertDirectEffectsClear,assertDirectNativeBarrier} from "@wasalx/core/direct-keep-open";
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { botActionCapabilities, supportsBotActionInvocation } from "@wasalx/core/bot-action-capabilities";
import { directMessageCapabilities, parseBotFlow, validateBotFlowVariableProvenance, type BotFlowDefinition } from "@wasalx/core/bot-flow";
import { parseTicketEventFlow, ticketEvents, validateTicketEventCapabilities, type TicketEventDefinition } from "@wasalx/core/ticket-event-flow";
import { maximumMediaBytes, normalizeMediaMime, safeMediaFilename } from "@wasalx/core/media";
import { providerOutboundMediaRule } from "@wasalx/core/provider-media-capabilities";
import { botHandoffMaxAttemptsFromEnvironment } from "@wasalx/core/delivery";
import { isOwnedSecretReference } from "@wasalx/core/secret-reference";
import { clientRoutingApplies, clientRoutingTargetBlockers, hasCredentialQueryParameter, parseClientRouting, resolveClientRoute, type ClientRoutingDefinition, type ClientRoutingInput } from "@wasalx/core/client-routing";
import type { PoolClient } from "pg";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import type { Principal } from "./types.js";
import { listCursor, listLimit, takeListPage, type ListPageQuery } from "./list-pagination.js";
import { ZammadRoutingCatalogService } from "./zammad-routing-catalog.service.js";
import { WebhookSecretService } from "./webhook-secret.service.js";
import { RoutingConnectorsConfig } from "./routing-connectors.config.js";
import { SecretProvisioningService } from "./secret-provisioning.service.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import { findOperationReceipt, requireOperationKey, withOperationReceipt } from "./idempotent-operation.js";

type WorkflowDefinition = BotFlowDefinition | TicketEventDefinition;
const isTicketEvent = (definition: WorkflowDefinition): definition is TicketEventDefinition => "kind" in definition && definition.kind === "TICKET_EVENT";

type OperationAction = "CREATE" | "CLONE" | "ACTIVATE" | "ASSIGN" | "ASSIGNMENT_STATE" | "ASSIGNMENT_ATTRIBUTION" | "CONVERSATION_COMMAND" | "ROUTING_CREATE" | "ROUTING_ACTIVATE" | "ROUTING_SYNC" | "ACTION_SAVE" | "TICKET_EVENT_BIND";
type ConversationRow = Record<string, unknown> & {
  id: string;
  last_activity_at: string | Date;
  pagination_activity_at: string;
};
type ConversationCursor = { v:1; tenant:string; at:string; id:string };
type ConversationEventRow = Record<string, unknown> & {
  id: string;
  pagination_created_at: string;
};
type ConversationEventCursor = { v:1; tenant:string; conversation:string; at:string; id:string };
const CONVERSATION_PAGE_MAX=100;
const LEGACY_CONVERSATION_LIMIT=200;
const CATALOG_PAGE_MAX=100;
type CatalogKind="FLOW"|"ROUTING"|"ACTION";
type CatalogCursor={v:1;tenant:string;kind:CatalogKind;sort:string;id:string};

@Injectable()
export class BotFlowsService {
  private readonly botHandoffMaxAttempts = botHandoffMaxAttemptsFromEnvironment(process.env);

  constructor(private readonly database: DatabaseService,private readonly drain:TenantDrainService,private readonly catalogs:ZammadRoutingCatalogService,private readonly webhookSecrets?:WebhookSecretService,private readonly routingConnectors?:RoutingConnectorsConfig,private readonly secretProvisioning?:SecretProvisioningService) {}

  async list(principal: Principal, query: ListPageQuery = {}) {
    const limit = listLimit(query.limit);
    const cursor = listCursor(query.cursor);
    const rows = await this.database.rows<Record<string, unknown> & { flow_version_id: string }>(
      principal.tenantId,
      `WITH cursor_position AS (
         SELECT family.name,version.version,version.id
           FROM bot_flow_versions version JOIN bot_flow_families family
             ON family.tenant_id=version.tenant_id AND family.id=version.family_id
          WHERE version.tenant_id=$1 AND version.id=$2::uuid
       )
       SELECT family.id AS family_id,COALESCE(NULLIF(version.definition->>'name',''),family.name) AS name,version.id AS flow_version_id,
              version.version,version.state,version.revision,version.snapshot_sha256,
              version.definition,version.created_at,version.activated_at,version.retired_at,
              COALESCE(assignment_data.assignment_count,0)::bigint AS assignment_count
         FROM bot_flow_families family
         JOIN bot_flow_versions version
           ON version.tenant_id=family.tenant_id AND version.family_id=family.id
         LEFT JOIN LATERAL (
           SELECT count(*) AS assignment_count FROM bot_assignments assignment
            WHERE assignment.tenant_id=family.tenant_id
              AND assignment.flow_family_id=family.id AND assignment.flow_version_id=version.id
              AND assignment.state='ACTIVE'
         ) assignment_data ON true
        WHERE family.tenant_id=$1 AND ($2::uuid IS NULL OR EXISTS (
          SELECT 1 FROM cursor_position boundary
           WHERE family.name>boundary.name OR
              (family.name=boundary.name AND (version.version,version.id)<(boundary.version,boundary.id))
        ))
        ORDER BY family.name,version.version DESC,version.id DESC LIMIT $3`,
      [principal.tenantId,cursor,limit+1],
    );
    return takeListPage(rows, limit, row => row.flow_version_id);
  }

  async ticketEventConfiguration(principal:Principal){
    const [bindings,groups,members]=await Promise.all([
      this.database.rows(principal.tenantId,`SELECT id,whatsapp_group_id,event,mode,flow_version_id,revision
        FROM ticket_event_bindings WHERE tenant_id=$1 ORDER BY event,whatsapp_group_id NULLS FIRST`,[principal.tenantId]),
      this.database.rows(principal.tenantId,`SELECT group_record.id,COALESCE(group_record.wasalx_name,group_record.display_name) AS display_name,connection.provider
        FROM whatsapp_groups group_record JOIN connections connection ON connection.tenant_id=group_record.tenant_id
          AND connection.id=group_record.connection_id WHERE group_record.tenant_id=$1
        ORDER BY COALESCE(group_record.wasalx_name,group_record.display_name),group_record.id`,[principal.tenantId]),
      this.database.rows(principal.tenantId,`SELECT membership.id,person.display_name,membership.role
        FROM tenant_memberships membership JOIN users person ON person.id=membership.user_id
        WHERE membership.tenant_id=$1 AND membership.state='ACTIVE' AND cardinality(membership.whatsapp_numbers)>0
        ORDER BY person.display_name,membership.id`,[principal.tenantId]),
    ]);
    return{bindings,groups,members};
  }

  bindTicketEvent(principal:Principal,idempotencyKey:string,requestId:string,body:unknown){
    const input=object(body,"Ticket event assignment");
    const event=String(input.event);
    if(!ticketEvents.some(value=>value===event))throw new BadRequestException("Ticket event is invalid");
    const groupId=input.groupId==null?null:uuid(input.groupId,"Group ID");
    const mode=String(input.mode);
    if(!["CUSTOM","OFF","INHERIT"].includes(mode)||(!groupId&&mode==="INHERIT"))throw new BadRequestException("Assignment mode is invalid");
    const flowVersionId=mode==="CUSTOM"?uuid(input.flowVersionId,"Workflow version ID"):null;
    if(mode!=="CUSTOM"&&input.flowVersionId!=null)throw new BadRequestException("Only a custom assignment selects a workflow");
    const expectedRevision=boundedNumber(input.expectedRevision,0,Number.MAX_SAFE_INTEGER,"Assignment revision");
    return this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"TICKET_EVENT_BIND",idempotencyKey,
      hash({event,groupId,mode,flowVersionId,expectedRevision}),requestId,async()=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`ticket-event-config:${principal.tenantId}`]);
        const current=(await client.query<{id:string;revision:string|number}>(`SELECT id,revision FROM ticket_event_bindings
          WHERE tenant_id=$1 AND event=$2 AND whatsapp_group_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
          [principal.tenantId,event,groupId])).rows[0];
        if(Number(current?.revision??0)!==expectedRevision)throw new ConflictException("Ticket event assignment changed; refresh before saving");
        const providers=(await client.query<{provider:"WAHA"|"META"}>(`SELECT DISTINCT connection.provider
          FROM whatsapp_groups group_record JOIN connections connection ON connection.tenant_id=group_record.tenant_id
            AND connection.id=group_record.connection_id
          WHERE group_record.tenant_id=$1 AND ($2::uuid IS NULL OR group_record.id=$2)`,[principal.tenantId,groupId])).rows;
        if(groupId&&!providers.length)throw new NotFoundException("Group was not found");
        if(flowVersionId){
          const stored=(await client.query<{definition:unknown}>(`SELECT definition FROM bot_flow_versions
            WHERE tenant_id=$1 AND id=$2 AND state IN ('ACTIVE','RETIRED')`,[principal.tenantId,flowVersionId])).rows[0];
          if(!stored)throw new NotFoundException("Published workflow was not found");
          let definition:TicketEventDefinition;
          try{definition=parseTicketEventFlow(stored.definition);
            if(definition.event!==event)throw new Error("The workflow belongs to another ticket event");
            for(const provider of providers)validateTicketEventCapabilities(definition,provider.provider,provider.provider==="WAHA");
          }catch(error){throw new BadRequestException(error instanceof Error?error.message:"Ticket workflow is invalid")}
          if(definition.permission?.mode==="SPECIFIC"){
            const members=(await client.query<{id:string}>(`SELECT id FROM tenant_memberships
              WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND state='ACTIVE' AND cardinality(whatsapp_numbers)>0 FOR SHARE`,
              [principal.tenantId,definition.permission.memberIds])).rows;
            if(members.length!==definition.permission.memberIds.length)throw new BadRequestException("Select active workspace members with registered WhatsApp numbers");
          }
        }
        const saved=(await client.query<{id:string;revision:string|number}>(`INSERT INTO ticket_event_bindings
          (tenant_id,whatsapp_group_id,event,mode,flow_version_id,updated_by)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (tenant_id,whatsapp_group_id,event) DO UPDATE SET mode=EXCLUDED.mode,flow_version_id=EXCLUDED.flow_version_id,
            revision=ticket_event_bindings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()
          RETURNING id,revision`,[principal.tenantId,groupId,event,mode,flowVersionId,principal.userId])).rows[0]!;
        const result={id:saved.id,event,groupId,mode,flowVersionId,revision:Number(saved.revision)};
        await appendAudit(client,principal,{action:"ticket_event.assigned",targetType:"ticket_event_binding",targetId:saved.id,requestId,newValue:result});
        return result;
      }));
  }

  async flowCatalog(principal:Principal,input:{cursor?:unknown;limit?:string}={}){
    const limit=catalogPageLimit(input.limit);const cursor=catalogCursor(input.cursor,principal.tenantId,"FLOW");
    const rows=await this.database.rows<Record<string,unknown>&{flow_version_id:string;pagination_sort:string}>(principal.tenantId,`SELECT family.id AS family_id,COALESCE(NULLIF(version.definition->>'name',''),family.name) AS name,version.id AS flow_version_id,
      version.version,version.state,version.revision,version.snapshot_sha256,version.created_at,version.activated_at,version.retired_at,
      version.definition->>'kind' AS kind,version.definition->>'event' AS event,
      COALESCE(assignment_data.assignment_count,0)::bigint AS assignment_count,family.name AS pagination_sort
      FROM bot_flow_families family JOIN bot_flow_versions version
        ON version.tenant_id=family.tenant_id AND version.family_id=family.id
      LEFT JOIN LATERAL (SELECT count(*) AS assignment_count FROM bot_assignments assignment
        WHERE assignment.tenant_id=family.tenant_id AND assignment.flow_family_id=family.id AND assignment.flow_version_id=version.id AND assignment.state='ACTIVE') assignment_data ON true
      WHERE family.tenant_id=$1 AND ($2::text IS NULL OR family.name>$2 OR
        (family.name=$2 AND (version.version<$3::integer OR
          (version.version=$3::integer AND version.id<$4::uuid))))
      ORDER BY family.name,version.version DESC,version.id DESC LIMIT $5`,[
      principal.tenantId,cursor?.sort.split("\u001f",1)[0]??null,cursor?.sort.split("\u001f")[1]??null,cursor?.id??null,limit+1,
    ]);
    return catalogPage(rows,limit,principal.tenantId,"FLOW",row=>`${String(row.pagination_sort)}\u001f${Number(row.version)}`,row=>String(row.flow_version_id));
  }

  async flowDetail(principal:Principal,idValue:string){const id=uuid(idValue,"Bot flow version ID");const row=(await this.database.rows<Record<string,unknown>>(principal.tenantId,`SELECT family.id AS family_id,COALESCE(NULLIF(version.definition->>'name',''),family.name) AS name,version.id AS flow_version_id,
      version.version,version.state,version.revision,version.snapshot_sha256,version.definition,version.created_at,version.activated_at,version.retired_at,
      (SELECT active.id FROM bot_flow_versions active WHERE active.tenant_id=version.tenant_id
        AND active.family_id=version.family_id AND active.state='ACTIVE') AS active_flow_version_id,
      COALESCE(assignment_data.assignment_count,0)::bigint AS assignment_count
      FROM bot_flow_families family JOIN bot_flow_versions version ON version.tenant_id=family.tenant_id AND version.family_id=family.id
      LEFT JOIN LATERAL (SELECT count(*) AS assignment_count FROM bot_assignments assignment WHERE assignment.tenant_id=family.tenant_id
        AND assignment.flow_family_id=family.id AND assignment.flow_version_id=version.id AND assignment.state='ACTIVE') assignment_data ON true
      WHERE family.tenant_id=$1 AND version.id=$2`,[principal.tenantId,id]))[0];if(!row)throw new NotFoundException("Bot flow version was not found");return row}

  async listMediaAssets(principal: Principal, requestedIds: string[] = [], query: ListPageQuery = {}) {
    if (requestedIds.length > 100) throw new BadRequestException("Too many media files were requested");
    const ids = [...new Set(requestedIds.map(value => uuid(value, "Media asset ID")))];
    const limit = listLimit(query.limit);
    const cursor = listCursor(query.cursor);
    const rows = await this.database.rows<Record<string, unknown> & { id: string; pagination_requested: boolean }>(
      principal.tenantId, `WITH requested AS (
        SELECT id,filename,mime_type,byte_size,state,created_at,updated_at,true AS pagination_requested
          FROM bot_media_assets WHERE tenant_id=$1 AND state='READY' AND $3::uuid IS NULL AND id=ANY($2::uuid[])
      ), cursor_position AS (
        SELECT created_at,id FROM bot_media_assets WHERE tenant_id=$1 AND state='READY' AND id=$3::uuid
      ), recent AS (
        SELECT id,filename,mime_type,byte_size,state,created_at,updated_at,false AS pagination_requested
          FROM bot_media_assets WHERE tenant_id=$1 AND state='READY' AND NOT (id=ANY($2::uuid[]))
           AND ($3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM cursor_position boundary WHERE
               bot_media_assets.created_at<boundary.created_at OR
               (bot_media_assets.created_at=boundary.created_at AND bot_media_assets.id>boundary.id)
           ))
         ORDER BY created_at DESC,id LIMIT $4
      ) SELECT * FROM requested UNION ALL SELECT * FROM recent ORDER BY created_at DESC,id`,
      [principal.tenantId, ids, cursor, limit+1],
    );
    const { items: normal, next_cursor } = takeListPage(rows.filter(row => !row.pagination_requested), limit, row => row.id);
    const normalIds = new Set(normal.map(row => row.id));
    const items = rows.filter(row => row.pagination_requested || normalIds.has(row.id)).map(row => {
      const item: Record<string, unknown> = { ...row };
      delete item.pagination_requested;
      return item;
    });
    return { items, next_cursor };
  }

  async createMediaAsset(principal:Principal,idempotencyKey:string,requestId:string,body:unknown){
    requireOperationKey(idempotencyKey);uuid(idempotencyKey,"Media upload idempotency key");const input=mediaAssetInput(body);const requestSha256=hash(input);
    return this.database.withTenant(principal.tenantId,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`bot-media-quota:${principal.tenantId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`bot-media-upload:${principal.tenantId}:${idempotencyKey}`]);
      const existing=(await client.query<{id:string;request_sha256:string|null;state:string}>(`SELECT id,request_sha256,state FROM bot_media_assets
        WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,[principal.tenantId,idempotencyKey])).rows[0];
      if(existing&&existing.request_sha256!==null&&existing.request_sha256!==requestSha256)throw new ConflictException("Idempotency key was already used for another media file");
      const id=existing?.id??randomUUID();
      if(!existing){
        const limits=(await client.query<{bot_media_asset_count_limit:number;bot_media_asset_bytes_limit:string}>(`SELECT bot_media_asset_count_limit,bot_media_asset_bytes_limit
          FROM tenant_settings WHERE tenant_id=$1`,[principal.tenantId])).rows[0];
        if(!limits)throw new ServiceUnavailableException("Media upload limits are unavailable");
        const usage=(await client.query<{active_count:string;active_bytes:string}>(`SELECT count(*)::text AS active_count,COALESCE(sum(byte_size),0)::text AS active_bytes
          FROM bot_media_assets WHERE tenant_id=$1 AND state IN ('UPLOADING','READY','RETIRED','PURGE_PENDING')`,[principal.tenantId])).rows[0];
        if(!usage||BigInt(usage.active_count)+1n>BigInt(limits.bot_media_asset_count_limit)||BigInt(usage.active_bytes)+BigInt(input.byteSize)>BigInt(limits.bot_media_asset_bytes_limit))throw new ConflictException("Media storage limit reached. Remove unused media before uploading another file.");
        await client.query(`INSERT INTO bot_media_assets
          (id,tenant_id,filename,mime_type,byte_size,declared_sha256,idempotency_key,request_sha256,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,principal.tenantId,input.filename,input.mimeType,input.byteSize,input.contentSha256,idempotencyKey,requestSha256,principal.userId]);
      }
      else if(existing.state==="UPLOADING")await client.query("UPDATE bot_media_assets SET upload_expires_at=now()+interval '10 minutes',updated_at=now() WHERE tenant_id=$1 AND id=$2",[principal.tenantId,id]);
      const state=existing?.state??"UPLOADING";const uploadToken=state==="UPLOADING"?await this.drain.issueMediaUploadToken(principal.tenantId,id):undefined;
      const result={id,state,...input,tenantId:principal.tenantId,...(uploadToken?{uploadToken}:{})};
      if(!existing)await appendAudit(client,principal,{action:"bot_media_asset.upload_started",targetType:"bot_media_asset",targetId:id,requestId,newValue:{id,state:"UPLOADING",mime_type:input.mimeType,byte_size:input.byteSize}});
      return result;
    });
  }

  async listActions(principal: Principal, query: ListPageQuery = {}) {
    const limit = listLimit(query.limit);
    const cursor = listCursor(query.cursor);
    const rows=await this.database.rows<Record<string,unknown>&{id:string}>(principal.tenantId,`SELECT id,action_key,name,kind,endpoint_url,http_method,
      auth_scheme,secret_reference,headers,response_mapping,timeout_ms,max_response_bytes,state,revision,
      active_revision_id,revision AS active_action_revision,created_at,updated_at
      FROM bot_action_definitions WHERE tenant_id=$1 AND ($2::uuid IS NULL OR (name,action_key)>
        (SELECT name,action_key FROM bot_action_definitions WHERE tenant_id=$1 AND id=$2::uuid))
      ORDER BY name,action_key LIMIT $3`,[principal.tenantId,cursor,limit+1]);
    const page = takeListPage(rows, limit, row => row.id);
    const visible:Array<Record<string,unknown>&{capabilities:ReturnType<typeof botActionCapabilities>}>=page.items.map(row=>{const capabilities=botActionCapabilities({
      kind:row.kind,endpointUrl:row.endpoint_url,httpMethod:row.http_method,authScheme:row.auth_scheme,secretReference:row.secret_reference,
    });return{...row,capabilities,qualification_supported:row.state==="ACTIVE"&&capabilities.retry_semantics==="REPLAY_SAFE"}});
    const items = principal.role==="tenant_owner"||principal.role==="tenant_admin" ? visible
      : visible.map(row=>({...row,endpoint_url:redactEndpointQuery(row.endpoint_url),secret_reference:null,headers:{}}));
    return { items, next_cursor: page.next_cursor };
  }

  async actionCatalog(principal:Principal,input:{cursor?:unknown;limit?:string}={}){
    const limit=catalogPageLimit(input.limit);const cursor=catalogCursor(input.cursor,principal.tenantId,"ACTION");
    const rows=await this.database.rows<Record<string,unknown>&{id:string;name:string}>(principal.tenantId,`SELECT id,action_key,name,kind,http_method,state,revision,
      active_revision_id,revision AS active_action_revision,created_at,updated_at
      FROM bot_action_definitions WHERE tenant_id=$1
        AND ($2::text IS NULL OR (name,id)>($2::text,$3::uuid))
      ORDER BY name,id LIMIT $4`,[principal.tenantId,cursor?.sort??null,cursor?.id??null,limit+1]);
    return catalogPage(rows,limit,principal.tenantId,"ACTION",row=>String(row.name),row=>String(row.id));
  }

  async actionDetail(principal:Principal,actionKeyValue:string){const actionKey=actionKeyPath(actionKeyValue);const rows=await this.database.rows<Record<string,unknown>>(principal.tenantId,`SELECT id,action_key,name,kind,endpoint_url,http_method,
      auth_scheme,secret_reference,headers,response_mapping,timeout_ms,max_response_bytes,state,revision,
      active_revision_id,revision AS active_action_revision,created_at,updated_at
      FROM bot_action_definitions WHERE tenant_id=$1 AND action_key=$2`,[principal.tenantId,actionKey]);
    const row=rows[0];if(!row)throw new NotFoundException("Bot action was not found");const capabilities=botActionCapabilities({kind:row.kind,endpointUrl:row.endpoint_url,httpMethod:row.http_method,authScheme:row.auth_scheme,secretReference:row.secret_reference});
    const visible:Record<string,unknown>&{capabilities:ReturnType<typeof botActionCapabilities>}={...row,capabilities,qualification_supported:row.state==="ACTIVE"&&capabilities.retry_semantics==="REPLAY_SAFE"};
    return principal.role==="tenant_owner"||principal.role==="tenant_admin"?visible:{...visible,endpoint_url:redactEndpointQuery(visible.endpoint_url),secret_reference:null,headers:{}};
  }

  async listActionRevisions(principal:Principal,actionKeyValue:string,query:ListPageQuery={}){
    const actionKey=actionKeyPath(actionKeyValue);
    const limit = listLimit(query.limit);
    const cursor = listCursor(query.cursor);
    const rows=await this.database.rows<Record<string,unknown>&{id:string}>(principal.tenantId,`SELECT revision.id,revision.revision,revision.name,revision.kind,
      revision.endpoint_url,revision.http_method,revision.auth_scheme,revision.headers,revision.response_mapping,
      revision.timeout_ms,revision.max_response_bytes,revision.state,revision.snapshot_sha256,revision.created_at,
      revision.id=action.active_revision_id AS active
      FROM bot_action_definitions action JOIN bot_action_revisions revision
        ON revision.tenant_id=action.tenant_id AND revision.action_definition_id=action.id
      WHERE action.tenant_id=$1 AND action.action_key=$2 AND ($3::uuid IS NULL OR revision.revision<
        (SELECT boundary.revision FROM bot_action_revisions boundary
          WHERE boundary.tenant_id=$1 AND boundary.action_definition_id=action.id AND boundary.id=$3::uuid))
      ORDER BY revision.revision DESC LIMIT $4`,[principal.tenantId,actionKey,cursor,limit+1]);
    if(!rows.length && !cursor)throw new NotFoundException("Bot action was not found");
    const page = takeListPage(rows, limit, row => row.id);
    const items = principal.role==="tenant_owner"||principal.role==="tenant_admin" ? page.items
      : page.items.map(row=>({...row,endpoint_url:redactEndpointQuery(row.endpoint_url),headers:{}}));
    return { items, next_cursor: page.next_cursor };
  }

  async restoreActionRevision(principal:Principal,actionKeyValue:string,revisionValue:string,idempotencyKey:string,requestId:string,body:unknown){
    const actionKey=actionKeyPath(actionKeyValue);const sourceRevision=boundedNumber(Number(revisionValue),1,Number.MAX_SAFE_INTEGER,"Plugin revision");
    const input=actionRestore(body);const row=(await this.database.rows<Record<string,unknown>>(principal.tenantId,`SELECT revision.name,revision.kind,
        revision.endpoint_url,revision.http_method,revision.auth_scheme,revision.secret_reference,revision.headers,revision.response_mapping,
        revision.timeout_ms,revision.max_response_bytes,revision.state
      FROM bot_action_definitions action JOIN bot_action_revisions revision
        ON revision.tenant_id=action.tenant_id AND revision.action_definition_id=action.id
      WHERE action.tenant_id=$1 AND action.action_key=$2 AND revision.revision=$3`,[principal.tenantId,actionKey,sourceRevision]))[0];
    if(!row)throw new NotFoundException("Plugin revision was not found");
    return this.saveAction(principal,idempotencyKey,requestId,{actionKey,name:row.name,kind:row.kind,endpointUrl:row.endpoint_url,
      httpMethod:row.http_method,authScheme:row.auth_scheme,secretReference:row.secret_reference,headers:row.headers,
      responseMapping:row.response_mapping,timeoutMs:row.timeout_ms,maxResponseBytes:row.max_response_bytes,state:row.state,
      expectedRevision:input.expectedRevision},sourceRevision);
  }

  async storeActionCredential(principal: Principal, idempotencyKey: string, requestIdOrBody: string|unknown, body?: unknown) {
    if (!this.secretProvisioning) throw new ServiceUnavailableException("Plugin credential storage is unavailable");
    const requestId=body===undefined?idempotencyKey:String(requestIdOrBody);const value=body===undefined?requestIdOrBody:body;
    const key=operationKey(body===undefined?requestId:idempotencyKey);const input=actionCredential(value);
    const reference=`secret://tenants/${principal.tenantId}/bot-actions/${input.actionKey}/credentials/${createHash("sha256").update(`${principal.tenantId}:${key}`).digest("hex")}`;
    const credentialSha256=createHash("sha256").update(input.credential).digest("hex");
    const stage=await this.database.withTenant(principal.tenantId,async client=>{
      await requirePrivilegedAuthentication(client,principal,"adding or replacing a plugin action credential");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`bot-action-credential:${principal.tenantId}:${key}`]);
      const existing=(await client.query<{id:string;action_key:string;secret_reference:string;credential_sha256:string;state:string;available:boolean}>(`SELECT id,action_key,secret_reference,credential_sha256,state,
        expires_at>now() AS available
        FROM bot_action_credential_stages WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,[principal.tenantId,key])).rows[0];
      if(existing){
        if(existing.action_key!==input.actionKey||existing.credential_sha256!==credentialSha256)throw new ConflictException("Idempotency key was already used for another plugin credential");
        if(existing.state==="STAGED"&&!existing.available)throw new ConflictException("Plugin credential stage expired; add the credential again");
        if(existing.state==="STAGED")await client.query(`UPDATE bot_action_credential_stages
          SET expires_at=now()+interval '1 hour' WHERE tenant_id=$1 AND id=$2 AND state='STAGED'`,[principal.tenantId,existing.id]);
        return{credentialStageId:existing.id,secretReference:existing.secret_reference,state:existing.state,duplicate:true,write:existing.state==="STAGED"};
      }
      const stageId=randomUUID();
      await client.query(`INSERT INTO bot_action_credential_stages
        (id,tenant_id,action_key,idempotency_key,secret_reference,credential_sha256,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,[stageId,principal.tenantId,input.actionKey,key,reference,credentialSha256,principal.userId]);
      await appendAudit(client,principal,{action:"bot_action.credential_staged",targetType:"bot_action",targetId:input.actionKey,requestId,newValue:{credential_stage_id:stageId}});
      return{credentialStageId:stageId,secretReference:reference,state:"STAGED",duplicate:false,write:true};
    });
    if(stage.write)try{await this.secretProvisioning.storeBotActionCredential(stage.secretReference,input.credential)}catch{throw new ServiceUnavailableException("Plugin credential storage is temporarily unavailable. Retry this request safely.")}
    const response={...stage};delete (response as {write?:boolean}).write;return response;
  }

  listAssignments(principal: Principal) {
    return this.database.rows(principal.tenantId,`SELECT assignment.id,assignment.connection_id,connection.name AS connection_name,
      connection.provider,connection.engine,connection.state AS connection_state,assignment.flow_family_id,
      COALESCE(NULLIF(version.definition->>'name',''),family.name) AS flow_name,assignment.flow_version_id,
      version.version,assignment.zammad_group_id,assignment.agent_prefix,assignment.agent_identity_placement,
      assignment.state,assignment.revision,assignment.created_at,assignment.updated_at
      FROM bot_assignments assignment
      JOIN connections connection ON connection.tenant_id=assignment.tenant_id AND connection.id=assignment.connection_id
      JOIN bot_flow_families family ON family.tenant_id=assignment.tenant_id AND family.id=assignment.flow_family_id
      JOIN bot_flow_versions version ON version.tenant_id=assignment.tenant_id AND version.id=assignment.flow_version_id
      WHERE assignment.tenant_id=$1 ORDER BY connection.name,assignment.created_at`,[principal.tenantId]);
  }

  async listConversations(principal:Principal,input:{cursor?:unknown;limit?:string}={}){
    const paginated=input.limit!==undefined;
    if(input.cursor!==undefined&&!paginated)throw new BadRequestException("Conversation page limit is required with a cursor");
    const limit=paginated?conversationPageLimit(input.limit!):LEGACY_CONVERSATION_LIMIT;
    const cursor=conversationCursor(input.cursor,principal.tenantId);
    const rows=await this.database.rows<ConversationRow>(principal.tenantId,`SELECT conversation.id,conversation.connection_id,conversation.state,conversation.flow_version_id,
      conversation.current_node_id,conversation.step_count,conversation.fencing_token,conversation.zammad_ticket_number,
      conversation.last_activity_at,to_char(conversation.last_activity_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS pagination_activity_at,
      conversation.resolved_at,connection.name AS connection_name,connection.provider AS connection_provider,
      COALESCE(NULLIF(version.definition->>'name',''),family.name) AS flow_name,
      version.version,handoff.state AS handoff_state,handoff.attempts AS handoff_attempts,handoff.safe_error AS handoff_safe_error,
      action.id AS action_id,action.action_node_id,action.state AS action_state,action.safe_error AS action_safe_error,
      COALESCE(events.timeline,'[]'::jsonb) AS timeline
    FROM bot_conversations conversation
    JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
    JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
    JOIN bot_flow_families family ON family.tenant_id=version.tenant_id AND family.id=version.family_id
    LEFT JOIN LATERAL (SELECT state,attempts,safe_error FROM bot_handoff_jobs job
      WHERE job.tenant_id=conversation.tenant_id AND job.conversation_id=conversation.id
      ORDER BY job.created_at DESC LIMIT 1) handoff ON true
    LEFT JOIN LATERAL (SELECT id,action_node_id,state,safe_error FROM bot_action_jobs job
      WHERE job.tenant_id=conversation.tenant_id AND job.conversation_id=conversation.id
      ORDER BY job.created_at DESC LIMIT 1) action ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('kind',item.event_kind,'from',item.from_node_id,
      'to',item.to_node_id,'at',item.created_at) ORDER BY item.created_at) AS timeline
      FROM (SELECT event_kind,from_node_id,to_node_id,created_at FROM bot_conversation_events event
        WHERE event.tenant_id=conversation.tenant_id AND event.conversation_id=conversation.id
        ORDER BY event.created_at DESC LIMIT 20) item) events ON true
    WHERE conversation.tenant_id=$1
      AND ($2::timestamptz IS NULL OR (conversation.last_activity_at,conversation.id)<($2::timestamptz,$3::uuid))
    ORDER BY conversation.last_activity_at DESC,conversation.id DESC LIMIT $4`,[
      principal.tenantId,cursor?.at??null,cursor?.id??null,limit+1,
    ]);
    const pageRows=rows.slice(0,limit);
    const items=pageRows.map(row=>{
      const item:Record<string,unknown>={...row};
      delete item.pagination_activity_at;
      return item;
    });
    return{items,next_cursor:rows.length>limit?encodeConversationCursor(principal.tenantId,pageRows.at(-1)!):null};
  }

  async listConversationEvents(principal:Principal,targetId:string,input:{cursor?:unknown;limit?:string}={}){
    const conversationId=uuid(targetId,"Bot conversation ID");
    const limit=conversationPageLimit(input.limit??String(CONVERSATION_PAGE_MAX));
    const cursor=conversationEventCursor(input.cursor,principal.tenantId,conversationId);
    return this.database.withTenant(principal.tenantId,async client=>{
      const exists=(await client.query("SELECT 1 FROM bot_conversations WHERE tenant_id=$1 AND id=$2",[
        principal.tenantId,conversationId,
      ])).rowCount;
      if(exists!==1)throw new NotFoundException("Bot conversation was not found");
      const rows=(await client.query<ConversationEventRow>(`SELECT event.id,event.event_kind AS kind,event.from_node_id AS "from",
          event.to_node_id AS "to",event.created_at AS at,to_char(event.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS pagination_created_at
        FROM bot_conversation_events event
        WHERE event.tenant_id=$1 AND event.conversation_id=$2
          AND ($3::timestamptz IS NULL OR (event.created_at,event.id)<($3::timestamptz,$4::uuid))
        ORDER BY event.created_at DESC,event.id DESC LIMIT $5`,[
        principal.tenantId,conversationId,cursor?.at??null,cursor?.id??null,limit+1,
      ])).rows;
      const overlayEvents=(await client.query<Record<string,unknown>>(`SELECT event.event_kind AS kind,event.from_node_id AS "from",
          event.to_node_id AS "to",max(event.created_at) AS at
        FROM bot_conversation_events event
        WHERE event.tenant_id=$1 AND event.conversation_id=$2 AND event.event_kind=ANY($3::text[])
        GROUP BY event.event_kind,event.from_node_id,event.to_node_id
        ORDER BY max(event.created_at),event.event_kind,event.from_node_id,event.to_node_id`,[
        principal.tenantId,conversationId,["ACTION_SUCCEEDED","ACTION_FAILED","ACTION_OUTCOME_UNKNOWN","ACTION_RETRY_REQUESTED","HANDOFF_REQUESTED","HANDOFF_COMPLETED"],
      ])).rows;
      const pageRows=rows.slice(0,limit);
      const items=pageRows.map(row=>{const item:Record<string,unknown>={...row};delete item.pagination_created_at;return item});
      return{items,next_cursor:rows.length>limit?encodeConversationEventCursor(principal.tenantId,conversationId,pageRows.at(-1)!):null,overlay_events:overlayEvents};
    });
  }

  async listRouting(principal:Principal,query:ListPageQuery={}){
    const limit = listLimit(query.limit);
    const cursor = listCursor(query.cursor);
    const rows=await this.database.rows<Record<string,unknown>&{id:string}>(principal.tenantId,`SELECT id,version,state,revision,definition,snapshot_sha256,
      created_at,activated_at,retired_at FROM client_routing_versions
      WHERE tenant_id=$1 AND ($2::uuid IS NULL OR (version,id)<
        (SELECT version,id FROM client_routing_versions WHERE tenant_id=$1 AND id=$2::uuid))
      ORDER BY version DESC,id DESC LIMIT $3`,[principal.tenantId,cursor,limit+1]);
    const page = takeListPage(rows, limit, row => row.id);
    const items = principal.role==="tenant_owner"||principal.role==="tenant_admin" ? page.items
      : page.items.map(row=>({...row,definition:redactRoutingSecrets(row.definition)}));
    return { items, next_cursor: page.next_cursor };
  }

  async routingCatalog(principal:Principal,input:{cursor?:unknown;limit?:string}={}){
    const limit=catalogPageLimit(input.limit);const cursor=catalogCursor(input.cursor,principal.tenantId,"ROUTING");
    const rows=await this.database.rows<Record<string,unknown>&{id:string;version:number|string}>(principal.tenantId,`SELECT id,version,state,revision,snapshot_sha256,
      created_at,activated_at,retired_at FROM client_routing_versions WHERE tenant_id=$1
        AND ($2::integer IS NULL OR version<$2 OR (version=$2 AND id<$3::uuid))
      ORDER BY version DESC,id DESC LIMIT $4`,[principal.tenantId,cursor?Number(cursor.sort):null,cursor?.id??null,limit+1]);
    return catalogPage(rows,limit,principal.tenantId,"ROUTING",row=>String(row.version),row=>String(row.id));
  }

  async routingDetail(principal:Principal,idValue:string){const id=uuid(idValue,"Client routing version ID");const row=(await this.database.rows<Record<string,unknown>>(principal.tenantId,`SELECT id,version,state,revision,definition,snapshot_sha256,
      created_at,activated_at,retired_at FROM client_routing_versions WHERE tenant_id=$1 AND id=$2`,[principal.tenantId,id]))[0];
    if(!row)throw new NotFoundException("Client routing version was not found");return principal.role==="tenant_owner"||principal.role==="tenant_admin"?row:{...row,definition:redactRoutingSecrets(row.definition)};
  }

  routingCapabilities(){return{externalConnectorsEnabled:this.routingConnectors?.externalConnectorsEnabled===true,notionOAuthEnabled:this.routingConnectors?.notionOAuthEnabled===true}}

  async listRoutingIntegrations(principal:Principal){
    const rows=await this.database.rows<Record<string,unknown>>(principal.tenantId,
      `SELECT integration.id,integration.provider,integration.display_name,integration.secret_reference,integration.auth_scheme,
        integration.state,integration.revision,integration.created_at,integration.updated_at,
        source.source_id,source.last_success_at,job.state AS latest_test_state,job.safe_error AS latest_test_safe_error
       FROM app.list_client_routing_integrations() integration
       LEFT JOIN LATERAL (
         SELECT item.id,item.source_id,item.last_success_at FROM client_routing_source_state item
          WHERE item.tenant_id=$1 AND item.secret_reference=integration.secret_reference AND item.state<>'RETIRED'
          ORDER BY item.updated_at DESC,item.id DESC LIMIT 1
       ) source ON true
       LEFT JOIN LATERAL (
         SELECT item.state,item.safe_error FROM client_routing_sync_jobs item
          WHERE item.tenant_id=$1 AND item.source_state_id=source.id
          ORDER BY item.created_at DESC,item.id DESC LIMIT 1
       ) job ON true`,[principal.tenantId],
    );
    const canConfigure=principal.role==="tenant_owner"||principal.role==="tenant_admin";
    return rows.map(row=>{
      const bindingReference=canConfigure&&row.state==="CONNECTED"?row.secret_reference:null;
      const integration={...row};
      delete integration.secret_reference;
      delete integration.external_account_id;
      return{...integration,binding_reference:bindingReference};
    });
  }

  async storeRoutingCredential(principal:Principal,idempotencyKey:string,requestId:string,body:unknown){
    if(this.routingConnectors?.externalConnectorsEnabled!==true)throw new ServiceUnavailableException("External client-routing connectors are not enabled in this deployment");
    if(!this.secretProvisioning)throw new ServiceUnavailableException("Routing credential storage is unavailable");
    const input=routingCredential(body);const keySha256=hash(operationKey(idempotencyKey));
    const credentialSha256=hash(input.credential);
    const payloadSha256=hash({...input,credential:credentialSha256});
    let prepared:{integration_id:string;secret_reference:string;provider:"ZOHO"|"HTTP_JSON";display_name:string;auth_scheme:"BEARER"|"HMAC";state:string;revision:string|number;duplicate:boolean}|undefined;
    try{
      prepared=await this.database.withTenant(principal.tenantId,async client=>{
        await requirePrivilegedAuthentication(client,principal,"adding or replacing a routing connection credential");
        return(await client.query<NonNullable<typeof prepared>>(
          "SELECT * FROM app.begin_client_routing_credential($1,$2,$3,$4,$5,$6,$7,$8)",[
            principal.userId,input.provider,input.displayName,input.authScheme,input.integrationId,input.expectedRevision,keySha256,payloadSha256,
          ],
        )).rows[0];
      });
      if(!prepared)throw new Error("Routing credential could not be prepared");
      if(prepared.state==="CONNECTED")return{integrationId:prepared.integration_id,provider:prepared.provider,displayName:prepared.display_name,authScheme:prepared.auth_scheme,bindingReference:prepared.secret_reference,revision:Number(prepared.revision),duplicate:true};
      if(prepared.duplicate&&prepared.state!=="CONNECTING")throw new ConflictException("Routing credential provisioning did not complete; use a new request");
      const secret=input.authScheme==="HMAC"?{hmacKey:input.credential}:{accessToken:input.credential,hmacKey:Buffer.from(randomBytes(32)).toString("base64url")};
      const completed=await this.database.withTenant(principal.tenantId,async client=>{
        const staged=(await client.query<{state:string}>("SELECT state FROM client_routing_integrations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,prepared!.integration_id])).rows[0];
        if(!staged)throw new ConflictException("Routing credential changed; refresh before updating");
        if(staged.state==="CONNECTING")await this.secretProvisioning!.storeRoutingCredential(prepared!.secret_reference,secret);
        else if(staged.state!=="CONNECTED")throw new ConflictException("Routing credential provisioning stage is no longer available");
        const row=(await client.query<{integration_id:string;provider:"ZOHO"|"HTTP_JSON";display_name:string;auth_scheme:"BEARER"|"HMAC";secret_reference:string;revision:string|number;changed:boolean}>(
          "SELECT * FROM app.complete_client_routing_credential($1,$2)",[prepared!.integration_id,principal.userId],
        )).rows[0];
        if(!row)throw new ConflictException("Routing credential changed; refresh before updating");
        if(row.changed)await appendAudit(client,principal,{action:input.integrationId?"client_routing.integration_rotated":"client_routing.integration_connected",targetType:"client_routing_integration",targetId:row.integration_id,requestId,newValue:{provider:row.provider,display_name:row.display_name,auth_scheme:row.auth_scheme,revision:Number(row.revision),replaces_integration_id:input.integrationId}});
        return row;
      });
      return{integrationId:completed.integration_id,provider:completed.provider,displayName:completed.display_name,authScheme:completed.auth_scheme,bindingReference:completed.secret_reference,revision:Number(completed.revision),duplicate:prepared.duplicate||!completed.changed};
    }catch(error){
      if(postgresCode(error)==="40001")throw new ConflictException("Routing credential changed; refresh before updating");
      throw error;
    }
  }

  async testRoutingCredential(principal:Principal,integrationId:string,idempotencyKey:string,requestId:string,body:unknown){
    if(this.routingConnectors?.externalConnectorsEnabled!==true)throw new ServiceUnavailableException("External client-routing connectors are not enabled in this deployment");
    const id=uuid(integrationId,"Routing integration ID");const input=routingCredentialTest(body);
    const row=(await this.database.rows<{provider:string;state:string;revision:string|number;source_id:string|null;snapshot_revision:string|number|null}>(principal.tenantId,`SELECT integration.provider,integration.state,integration.revision,
        source.source_id,source.snapshot_revision
      FROM client_routing_integrations integration
      LEFT JOIN LATERAL (
        SELECT item.source_id,item.snapshot_revision FROM client_routing_source_state item
         WHERE item.tenant_id=integration.tenant_id AND item.secret_reference=integration.secret_reference AND item.state<>'RETIRED'
         ORDER BY item.updated_at DESC,item.id DESC LIMIT 1
      ) source ON true
      WHERE integration.tenant_id=$1 AND integration.id=$2`,[principal.tenantId,id]))[0];
    if(!row||!(["ZOHO","HTTP_JSON"].includes(row.provider)))throw new NotFoundException("Routing credential was not found");
    if(row.state!=="CONNECTED"||Number(row.revision)!==input.expectedRevision)throw new ConflictException("Routing credential changed; refresh before testing");
    if(!row.source_id||row.snapshot_revision===null)throw new ConflictException("Use this connection in an active routing version before testing it");
    const result=await this.syncRoutingSource(principal,row.source_id,idempotencyKey,requestId,{expectedSnapshotRevision:Number(row.snapshot_revision)});
    return{...result,integrationId:id};
  }

  async listRoutingQualifications(principal:Principal,versionIdValue:string){
    const versionId=uuid(versionIdValue,"Client routing version ID");
    const exists=(await this.database.rows<{available:boolean}>(principal.tenantId,"SELECT true AS available FROM client_routing_versions WHERE tenant_id=$1 AND id=$2",[principal.tenantId,versionId]))[0];
    if(!exists)throw new NotFoundException("Client routing version was not found");
    return this.database.rows<Record<string,unknown>>(principal.tenantId,`SELECT qualification.id AS qualification_id,qualification.source_id,
        qualification.integration_id,qualification.integration_revision,job.id AS job_id,job.state,job.attempts,job.safe_error,job.updated_at
      FROM client_routing_source_qualifications qualification JOIN LATERAL (
        SELECT item.id,item.state,item.attempts,item.safe_error,item.updated_at FROM client_routing_sync_jobs item
         WHERE item.tenant_id=qualification.tenant_id AND item.qualification_id=qualification.id
         ORDER BY item.created_at DESC,item.id DESC LIMIT 1
      ) job ON true WHERE qualification.tenant_id=$1 AND qualification.routing_version_id=$2
      ORDER BY qualification.created_at DESC,qualification.id DESC`,[principal.tenantId,versionId]);
  }

  async qualifyRoutingSource(principal:Principal,versionIdValue:string,sourceId:string,idempotencyKey:string,requestId:string,body:unknown){
    if(this.routingConnectors?.externalConnectorsEnabled!==true)throw new ServiceUnavailableException("External client-routing connectors are not enabled in this deployment");
    const versionId=uuid(versionIdValue,"Client routing version ID");if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(sourceId))throw new BadRequestException("Routing source is invalid");
    const input=routingSourceQualification(body);const requestKey=createHash("sha256").update(operationKey(idempotencyKey)).digest("hex");
    const result=await this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"ROUTING_SYNC",idempotencyKey,
      hash({action:"ROUTING_QUALIFY",versionId,sourceId,input}),requestId,async()=>{
        await requirePrivilegedAuthentication(client,principal,"testing an external routing connection");
        let row:{job_id:string;qualification_id:string;duplicate:boolean}|undefined;
        try{row=(await client.query<NonNullable<typeof row>>("SELECT * FROM app.request_client_routing_source_qualification($1,$2,$3,$4,$5,$6,$7)",[
          versionId,input.expectedRoutingRevision,sourceId,input.integrationId,input.expectedIntegrationRevision,principal.userId,requestKey,
        ])).rows[0]}catch(error){if(postgresCode(error)==="40001")throw new ConflictException("Routing connection changed; refresh before testing");throw error}
        if(!row)throw new Error("Routing qualification request did not return a result");
        const requested={jobId:row.job_id,qualificationId:row.qualification_id,routingVersionId:versionId,sourceId,duplicate:row.duplicate};
        await appendAudit(client,principal,{action:"client_routing.qualification_requested",targetType:"client_routing_source",targetId:sourceId,requestId,newValue:requested});
        return requested;
      }));
    await this.drain.wakeRouting(principal.tenantId);return result;
  }

  async startNotionRoutingOAuth(principal:Principal,requestId:string,body:unknown){const config=this.routingConnectors;if(!config?.notionOAuthEnabled)throw new ServiceUnavailableException("Notion connection is not configured in this deployment");const input=routingOAuthStart(body);const state=Buffer.from(randomBytes(32)).toString("base64url");const stateHash=createHash("sha256").update(state).digest("hex");const row=await this.database.withTenant(principal.tenantId,async client=>{
    await requirePrivilegedAuthentication(client,principal,"connecting a Notion workspace");
    const created=(await client.query<{integration_id:string;secret_reference:string}>("SELECT * FROM app.begin_client_routing_notion_oauth($1,$2,$3,$4)",[principal.userId,stateHash,config.notionOAuthRedirectUri,input.integrationId??null])).rows[0];if(!created)throw new Error("Notion connection could not be started");
    await appendAudit(client,principal,{action:"client_routing.integration_started",targetType:"client_routing_integration",targetId:created.integration_id,requestId,newValue:{provider:"NOTION"}});return created;
  });
    const authorization=new URL("https://api.notion.com/v1/oauth/authorize");authorization.search=new URLSearchParams({client_id:config.notionOAuthClientId,response_type:"code",owner:"user",redirect_uri:config.notionOAuthRedirectUri,state}).toString();return{authorizationUrl:authorization.toString(),integrationId:row.integration_id};
  }

  async completeNotionRoutingOAuth(principal:Principal,requestId:string,body:unknown){const config=this.routingConnectors;if(!config?.notionOAuthEnabled||!this.webhookSecrets||!this.secretProvisioning)throw new ServiceUnavailableException("Notion connection is not configured in this deployment");const input=routingOAuthCallback(body);const stateHash=createHash("sha256").update(input.state).digest("hex");const claim=await this.database.withTenant(principal.tenantId,async client=>{await requirePrivilegedAuthentication(client,principal,"connecting a Notion workspace");return(await client.query<{integration_id:string;secret_reference:string;redirect_uri:string}>("SELECT * FROM app.claim_client_routing_notion_oauth($1,$2)",[stateHash,principal.userId])).rows[0]});if(!claim)throw new ConflictException("Notion authorization expired or was already used. Connect again.");
    let stored=false;
    try{
      if(claim.redirect_uri!==config.notionOAuthRedirectUri)throw new ConflictException("Notion authorization configuration changed. Connect again.");
      const clientSecret=await this.webhookSecrets.resolveHmac(config.notionOAuthClientSecretReference,{kind:"exact",expectedReference:config.notionOAuthClientSecretReference});const token=await exchangeNotionCode(input.code,claim.redirect_uri,config.notionOAuthClientId,clientSecret);
      await this.secretProvisioning.storeRoutingCredential(claim.secret_reference,{accessToken:token.accessToken,hmacKey:Buffer.from(randomBytes(32)).toString("base64url"),...(token.refreshToken?{refreshToken:token.refreshToken}:{})});stored=true;const connected=await this.database.withTenant(principal.tenantId,async client=>{const row=(await client.query<{integration_id:string;display_name:string;external_account_id:string;revision:string|number}>("SELECT * FROM app.complete_client_routing_notion_oauth($1,$2,$3,$4)",[claim.integration_id,principal.userId,token.workspaceName,token.workspaceId])).rows[0];if(!row)throw new ConflictException("Notion connection changed. Connect again.");await appendAudit(client,principal,{action:"client_routing.integration_connected",targetType:"client_routing_integration",targetId:row.integration_id,requestId,newValue:{provider:"NOTION",display_name:row.display_name,revision:Number(row.revision)}});return row});return{integrationId:connected.integration_id,provider:"NOTION",displayName:connected.display_name,revision:Number(connected.revision)}
    }catch(error){if(stored)await this.secretProvisioning.deleteSecret(claim.secret_reference).catch(()=>undefined);await this.abortNotionRoutingOAuth(principal,requestId,{state:input.state,reason:"FAILED"}).catch(()=>undefined);if(postgresCode(error)==="23505")throw new ConflictException("This Notion workspace is already connected");throw error}
  }

  async abortNotionRoutingOAuth(principal:Principal,requestId:string,body:unknown){const input=routingOAuthAbort(body);const stateHash=createHash("sha256").update(input.state).digest("hex");const integrationId=await this.database.withTenant(principal.tenantId,async client=>{const row=(await client.query<{integration_id:string|null}>("SELECT app.abort_client_routing_notion_oauth($1,$2) AS integration_id",[stateHash,principal.userId])).rows[0];const id=row?.integration_id??null;if(id)await appendAudit(client,principal,{action:"client_routing.integration_aborted",targetType:"client_routing_integration",targetId:id,requestId,newValue:{provider:"NOTION",reason:input.reason}});return id});return{aborted:integrationId!==null,integrationId}}

  async listRoutingSources(principal:Principal){const rows=await this.database.rows<Record<string,unknown>&{source_id:string;secret_reference:string;sync_mode:string}>(principal.tenantId,`SELECT source.source_id,source.kind,source.sync_mode,source.state,source.snapshot_revision,source.snapshot_sha256,
      source.last_success_at,source.next_due_at,source.safe_error,source.secret_reference,
      job.state AS latest_job_state,job.trigger_kind AS latest_trigger_kind,job.attempts AS latest_job_attempts,job.safe_error AS latest_job_safe_error,job.updated_at AS latest_job_at
    FROM client_routing_source_state source
    LEFT JOIN LATERAL (SELECT state,trigger_kind,attempts,safe_error,updated_at FROM client_routing_sync_jobs item
      WHERE item.tenant_id=source.tenant_id AND item.source_state_id=source.id
        AND (item.trigger_kind<>'SCHEDULED' OR item.available_at<=now()) ORDER BY item.created_at DESC LIMIT 1) job ON true
    WHERE source.tenant_id=$1 AND source.state<>'RETIRED' ORDER BY source.source_id`,[principal.tenantId]);const canConfigure=principal.role==="tenant_owner"||principal.role==="tenant_admin";
    return Promise.all(rows.map(async row=>{let webhook_path:string|null=null;if(canConfigure&&this.routingConnectors?.externalConnectorsEnabled===true&&(row.sync_mode==="WEBHOOK"||row.sync_mode==="HYBRID")&&this.webhookSecrets)try{webhook_path=`/webhooks/routing/${await this.webhookSecrets.routingRouteToken(row.secret_reference,principal.tenantId,row.source_id)}`}catch{webhook_path=null}return Object.fromEntries([...Object.entries(row).filter(([key])=>key!=="secret_reference"),["webhook_path",webhook_path]])}))
  }

  async syncRoutingSource(principal:Principal,sourceId:string,idempotencyKey:string,requestId:string,body:unknown){
    if(this.routingConnectors?.externalConnectorsEnabled!==true)throw new ServiceUnavailableException("External client-routing connectors are not enabled in this deployment");
    if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(sourceId))throw new BadRequestException("Routing source is invalid");
    const input=routingSourceSync(body);const requestKey=createHash("sha256").update(idempotencyKey).digest("hex");
    const result=await this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"ROUTING_SYNC",idempotencyKey,
      hash({action:"ROUTING_SYNC",sourceId,input}),requestId,async()=>{
        let row:{job_id:string;snapshot_revision:string|number;duplicate:boolean}|undefined;
        try{row=(await client.query<NonNullable<typeof row>>("SELECT * FROM app.request_client_routing_source_sync($1,$2,$3,$4)",[sourceId,input.expectedSnapshotRevision,principal.userId,requestKey])).rows[0]}
        catch(error){if(postgresCode(error)==="40001")throw new ConflictException("Routing source changed; refresh before syncing");throw error}
        if(!row)throw new Error("Routing sync request did not return a result");
        const requested={jobId:row.job_id,sourceId,snapshotRevision:Number(row.snapshot_revision),alreadyPending:row.duplicate};
        await appendAudit(client,principal,{action:"client_routing.sync_requested",targetType:"client_routing_source",targetId:sourceId,requestId,newValue:requested});
        return requested;
      }));
    await this.drain.wakeRouting(principal.tenantId);
    return result;
  }

  createRouting(principal:Principal,idempotencyKey:string,requestId:string,body:unknown){
    const definition=clientRouting(body);
    assertTenantRoutingSecrets(definition,principal.tenantId);
    this.assertExternalRoutingConnectorsEnabled(definition);
    return this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"ROUTING_CREATE",idempotencyKey,
      hash({action:"ROUTING_CREATE",definition}),requestId,async()=>{
        if(definition.sources.some(source=>source.kind!=="MANUAL"))await requirePrivilegedAuthentication(client,principal,"configuring an external routing connection");
        await this.assertRoutingConnectionBindings(client,principal.tenantId,definition);
        const row=(await client.query<{id:string;version:string|number;state:string;revision:string|number;snapshot_sha256:string}>(
          "SELECT * FROM app.create_client_routing_version($1,$2)",[definition,principal.userId],
        )).rows[0];
        if(!row)throw new Error("Client routing version could not be persisted");
        const result={id:row.id,version:Number(row.version),state:row.state,revision:Number(row.revision),snapshotSha256:row.snapshot_sha256};
        await appendAudit(client,principal,{action:"client_routing.created",targetType:"client_routing_version",targetId:row.id,requestId,
          newValue:{...result,name:definition.name,source_kinds:[...new Set(definition.sources.map(source=>source.kind))],client_count:definition.clients.length}});
        return result;
      }));
  }

  async activateRouting(principal:Principal,targetId:string,idempotencyKey:string,requestId:string,body:unknown){
    const versionId=uuid(targetId,"Client routing version ID");const input=routingActivation(body);
    const version=(await this.database.rows<{definition:unknown}>(principal.tenantId,
      "SELECT definition FROM client_routing_versions WHERE tenant_id=$1 AND id=$2",[principal.tenantId,versionId]))[0];
    if(!version)throw new NotFoundException("Client routing version was not found");
    const definition=clientRouting(version.definition);this.assertExternalRoutingConnectorsEnabled(definition);const catalog=await this.catalogs.get(principal.tenantId,true);
    const blockers=clientRoutingTargetBlockers(definition,catalog);if(blockers.length)throw new BadRequestException(blockers);
    return this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"ROUTING_ACTIVATE",idempotencyKey,
      hash({action:"ROUTING_ACTIVATE",versionId,input}),requestId,async()=>{
        if(definition.sources.some(source=>source.kind!=="MANUAL"))await requirePrivilegedAuthentication(client,principal,"activating an external routing connection");
        await this.assertRoutingConnectionBindings(client,principal.tenantId,definition);
        const webhookHashes=await this.routingWebhookHashes(definition,principal.tenantId);
        let row:{active_version_id:string;retired_version_id:string|null;revision:string|number}|undefined;
        try{row=(await client.query<NonNullable<typeof row>>("SELECT * FROM app.activate_client_routing_version($1,$2,$3,$4)",
          [versionId,input.expectedRevision,input.expectedActiveRoutingVersionId,principal.userId])).rows[0]}
        catch(error){if(postgresCode(error)==="40001")throw new ConflictException("Client routing changed; refresh before activation");throw error}
        if(!row)throw new Error("Client routing activation did not return a result");
        await client.query("SELECT app.reconcile_client_routing_sources($1,$2,$3)",[versionId,principal.userId,webhookHashes]);
        const result={routingVersionId:row.active_version_id,retiredRoutingVersionId:row.retired_version_id,revision:Number(row.revision)};
        await appendAudit(client,principal,{action:"client_routing.activated",targetType:"client_routing_version",targetId:versionId,requestId,
          previousValue:{active_routing_version_id:row.retired_version_id},newValue:{...result,client_count:definition.clients.length}});
        return result;
      }));
  }

  private async routingWebhookHashes(definition:ClientRoutingDefinition,tenantId:string){try{return Object.fromEntries(await Promise.all(definition.sources.filter(source=>source.syncMode==="WEBHOOK"||source.syncMode==="HYBRID").map(async source=>{if(!source.secretReference||!this.webhookSecrets)throw new Error("Webhook secret service is unavailable");const token=await this.webhookSecrets.routingRouteToken(source.secretReference,tenantId,source.id);return[source.id,createHash("sha256").update(token).digest("hex")]})))}catch{throw new ServiceUnavailableException("Routing webhook verification is temporarily unavailable")}}

  private assertExternalRoutingConnectorsEnabled(definition:ClientRoutingDefinition){if(this.routingConnectors?.externalConnectorsEnabled===true)return;if(definition.sources.some(source=>source.kind!=="MANUAL"))throw new ServiceUnavailableException("External client-routing connectors are not enabled in this deployment")}

  private async assertRoutingConnectionBindings(client:Pick<PoolClient,"query">,tenantId:string,definition:ClientRoutingDefinition){
    const sources=definition.sources.filter(source=>source.kind!=="MANUAL");if(!sources.length)return;
    const references=[...new Set(sources.map(source=>source.secretReference!))];
    const rows=(await client.query<{secret_reference:string;provider:string;state:string}>(
      "SELECT secret_reference,provider,state FROM client_routing_integrations WHERE tenant_id=$1 AND secret_reference=ANY($2::text[]) FOR SHARE",
      [tenantId,references],
    )).rows;
    const bindings=new Map(rows.map(row=>[row.secret_reference,row]));
    for(const source of sources){const binding=bindings.get(source.secretReference!);if(!binding||binding.state!=="CONNECTED"||binding.provider!==source.kind)throw new BadRequestException(`Choose a connected ${source.kind==="HTTP_JSON"?"HTTPS":source.kind.toLocaleLowerCase("en")} connection for ${source.name}`)}
  }

  async simulateRouting(principal:Principal,body:unknown){
    const input=routingSimulation(body);const version=(await this.database.rows<{id:string;version:string|number;definition:unknown}>(principal.tenantId,
      `SELECT id,version,definition FROM client_routing_versions WHERE tenant_id=$1 AND ($2::uuid IS NULL AND state='ACTIVE' OR id=$2::uuid)
       ORDER BY CASE WHEN id=$2::uuid THEN 0 ELSE 1 END LIMIT 1`,[principal.tenantId,input.versionId]))[0];
    if(!version)throw new NotFoundException("An active client routing version was not found");
    const definition=clientRouting(version.definition);
    return{routingVersionId:version.id,version:Number(version.version),...(clientRoutingApplies(definition,input.match.entryGroupId)?resolveClientRoute(definition,input.match):{status:"DEPARTMENT",client:null,matchedBy:null,competingClientIds:[]})};
  }

  async commandConversation(principal:Principal,targetId:string,idempotencyKey:string,requestId:string,body:unknown){
    const conversationId=uuid(targetId,"Bot conversation ID");const input=conversationCommand(body);
    const result=await this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"CONVERSATION_COMMAND",idempotencyKey,
      hash({action:"CONVERSATION_COMMAND",conversationId,input}),requestId,async()=>{
        const current=(await client.query<{state:string;fencing_token:string|number;current_node_id:string;start_node:string;handoff_id:string|null;handoff_state:string|null;action_id:string|null;action_state:string|null;assignment_state:string;connection_state:string}>(`SELECT conversation.state,conversation.fencing_token,conversation.current_node_id,
            version.definition->>'start' AS start_node,handoff.id AS handoff_id,handoff.state AS handoff_state,
            action.id AS action_id,action.state AS action_state,
            assignment.state AS assignment_state,connection.state AS connection_state
          FROM bot_conversations conversation
          JOIN bot_flow_versions version ON version.tenant_id=conversation.tenant_id AND version.id=conversation.flow_version_id
          JOIN bot_assignments assignment ON assignment.tenant_id=conversation.tenant_id AND assignment.id=conversation.assignment_id
          JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
          LEFT JOIN LATERAL (SELECT id,state FROM bot_handoff_jobs job WHERE job.tenant_id=conversation.tenant_id
            AND job.conversation_id=conversation.id ORDER BY job.created_at DESC LIMIT 1) handoff ON true
          LEFT JOIN LATERAL (SELECT id,state FROM bot_action_jobs job WHERE job.tenant_id=conversation.tenant_id
            AND job.conversation_id=conversation.id ORDER BY job.created_at DESC LIMIT 1) action ON true
          WHERE conversation.tenant_id=$1 AND conversation.id=$2 FOR UPDATE OF conversation,assignment,connection`,[principal.tenantId,conversationId])).rows[0];
        if(!current)throw new NotFoundException("Bot conversation was not found");
        if(Number(current.fencing_token)!==input.expectedFencingToken)throw new ConflictException("Bot conversation changed; refresh before updating it");
        await assertDirectNativeBarrier(client,{tenantId:principal.tenantId,conversationId});
        const failedHandoff=current.state==="HANDOFF_PENDING"&&current.handoff_state==="FAILED_TERMINAL";
        const retryableHandoff=current.state==="HANDOFF_PENDING"&&current.handoff_state==="FAILED_RETRYABLE";
        const unknownAction=current.state==="ACTION_PENDING"&&current.action_state==="OUTCOME_UNKNOWN"&&Boolean(current.action_id);
        if(input.action==="RETRY_HANDOFF"&&!failedHandoff&&!retryableHandoff)throw new ConflictException("No failed human handoff is available to retry");
        if(input.action==="RETRY_ACTION"&&!unknownAction)throw new ConflictException("No action with an unknown outcome is available to retry");
        if(input.action==="HANDOFF_TO_HUMAN"&&!unknownAction)throw new ConflictException("No action with an unknown outcome is available for human handoff");
        if(input.action==="RESUME_BOT"&&current.state!=="HUMAN"&&!failedHandoff)throw new ConflictException("Only a human-owned or failed-handoff conversation can resume bot automation");
        if(input.action==="CLOSE"&&current.state!=="HUMAN"&&!failedHandoff&&!unknownAction)throw new ConflictException("Only a human-owned, failed-handoff, or ambiguous-action conversation can be closed");
        if(input.action==="RESUME_BOT"&&(current.assignment_state!=="ACTIVE"||current.connection_state!=="WORKING"))throw new ConflictException("Activate the bot assignment and WhatsApp connection before resuming");
        if(input.action==="RESUME_BOT")await assertDirectEffectsClear(client,{tenantId:principal.tenantId,conversationId});
        if(input.action==="RETRY_HANDOFF"){
          if(!current.handoff_id)throw new ConflictException("No failed human handoff is available to retry");
          const retried=retryableHandoff?await client.query(`UPDATE bot_handoff_jobs SET state='QUEUED',available_at=now(),safe_error=NULL,updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND state='FAILED_RETRYABLE' AND attempts<$3
              AND lease_id IS NULL AND lease_expires_at IS NULL`,[principal.tenantId,current.handoff_id,this.botHandoffMaxAttempts]):await client.query(`INSERT INTO bot_handoff_jobs
            (tenant_id,conversation_id,source_event_id,handoff_node_id,zammad_group_id,zammad_owner_id,priority)
            SELECT tenant_id,conversation_id,source_event_id,handoff_node_id,zammad_group_id,zammad_owner_id,priority FROM bot_handoff_jobs
            WHERE tenant_id=$1 AND id=$2 AND state='FAILED_TERMINAL' ON CONFLICT DO NOTHING`,[principal.tenantId,current.handoff_id]);
          if(retried.rowCount!==1)throw new ConflictException("The failed human handoff changed; refresh before retrying it");
          await client.query("UPDATE bot_conversations SET fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[principal.tenantId,conversationId]);
          await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata)
            VALUES ($1,$2,'HANDOFF_REQUESTED',$3,$3,$4)`,[principal.tenantId,conversationId,current.current_node_id,JSON.stringify({operator_retry:true})]);
        }else if(input.action==="RETRY_ACTION"){
          const retried=await client.query(`UPDATE bot_action_jobs SET state='FAILED_RETRYABLE',available_at=now(),safe_error=NULL,
            completed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='OUTCOME_UNKNOWN'`,[principal.tenantId,current.action_id]);
          if(retried.rowCount!==1)throw new ConflictException("The ambiguous action changed; refresh before retrying it");
          await client.query("UPDATE bot_conversations SET fencing_token=fencing_token+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[principal.tenantId,conversationId]);
          await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata)
            VALUES ($1,$2,'ACTION_RETRY_REQUESTED',$3,$3,$4)`,[principal.tenantId,conversationId,current.current_node_id,JSON.stringify({operator_retry:true})]);
        }else if(input.action==="HANDOFF_TO_HUMAN"){
          const pendingDelivery=await client.query(`SELECT 1 FROM delivery_outbox
            WHERE tenant_id=$1 AND bot_conversation_id=$2 AND direct_origin='BOT'
              AND ((state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE') OR (state IN ('OUTCOME_UNKNOWN','BLOCKED') AND NOT app.delivery_no_further_attempts(tenant_id,id)))
                OR (state='FAILED_TERMINAL' AND manual_retry_allowed))
            LIMIT 1 FOR UPDATE`,[principal.tenantId,conversationId]);
          if(pendingDelivery.rowCount)throw new ConflictException("Resolve the pending WhatsApp bot delivery before handing this conversation to a person");
          const handedOff=await client.query(`UPDATE bot_conversations SET state='HUMAN',human_ownership_epoch=human_ownership_epoch+1,human_pause_started_at=now(),customer_control=NULL,resolved_at=NULL,resolution_kind=NULL,
            fencing_token=fencing_token+1,updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND state='ACTION_PENDING' AND fencing_token=$3`,[principal.tenantId,conversationId,input.expectedFencingToken]);
          if(handedOff.rowCount!==1)throw new ConflictException("The ambiguous action changed; refresh before handing it to a person");
          await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata)
            VALUES ($1,$2,'HANDOFF_COMPLETED',$3,$3,$4)`,[principal.tenantId,conversationId,current.current_node_id,JSON.stringify({operator_command:true,action_outcome:"UNKNOWN",external_action_reissued:false})]);
        }else{
          const state=input.action==="RESUME_BOT"?"BOT":"RESOLVED";const event=input.action==="RESUME_BOT"?"RESUMED":"RESOLVED";
          await client.query(`UPDATE bot_conversations SET state=$1,current_node_id=CASE WHEN $1='BOT' THEN $2 ELSE current_node_id END,
            variables=CASE WHEN $1='BOT' THEN '{}'::jsonb ELSE variables END,step_count=CASE WHEN $1='BOT' THEN 0 ELSE step_count END,
            resolved_at=CASE WHEN $1='RESOLVED' THEN now() ELSE NULL END,resolution_kind=CASE WHEN $1='RESOLVED' THEN 'OPERATOR' ELSE NULL END,
            fencing_token=fencing_token+1,updated_at=now()
            WHERE tenant_id=$3 AND id=$4`,[state,current.start_node,principal.tenantId,conversationId]);
          await client.query(`INSERT INTO bot_conversation_events (tenant_id,conversation_id,event_kind,from_node_id,to_node_id,safe_metadata)
            VALUES ($1,$2,$3,$4,$5,$6)`,[principal.tenantId,conversationId,event,current.current_node_id,input.action==="RESUME_BOT"?current.start_node:current.current_node_id,JSON.stringify({operator_command:true})]);
        }
        const row=(await client.query<{state:string;current_node_id:string;fencing_token:string|number}>("SELECT state,current_node_id,fencing_token FROM bot_conversations WHERE tenant_id=$1 AND id=$2",[principal.tenantId,conversationId])).rows[0]!;
        const response={conversationId,state:row.state,currentNodeId:row.current_node_id,fencingToken:Number(row.fencing_token),command:input.action,wakeRequired:input.action==="RETRY_HANDOFF"||input.action==="RETRY_ACTION"};
        await appendAudit(client,principal,{action:`bot_conversation.${input.action.toLowerCase()}`,targetType:"bot_conversation",targetId:conversationId,requestId,newValue:{state:response.state,fencing_token:response.fencingToken}});
        return response;
      })) as Record<string,unknown>&{wakeRequired?:boolean};
    if(result.wakeRequired===true)await this.drain.wake(principal.tenantId);
    const response={...result};delete response.wakeRequired;return response;
  }

  saveAction(principal: Principal, idempotencyKey:string, requestIdOrBody:string|unknown, body?:unknown,restoredFromRevision?:number) {
    const requestId=body===undefined?idempotencyKey:String(requestIdOrBody);const value=body===undefined?requestIdOrBody:body;
    const operationIdempotencyKey=body===undefined?requestId:idempotencyKey;const input=actionDefinition(value);
    const actionSecretPrefix=`secret://tenants/${principal.tenantId}/bot-actions/`;
    const integrationSecretPrefix=`secret://tenants/${principal.tenantId}/routing/integrations/`;
    const actionSecretReference=`${actionSecretPrefix}${input.actionKey}`;
    if(input.secretReference!==null&&!isOwnedSecretReference(input.secretReference,{kind:"bot-action",tenantId:principal.tenantId,actionKey:input.actionKey,actionKind:input.kind}))throw new BadRequestException(
      input.secretReference.startsWith(actionSecretPrefix)?"Choose the credential staged for this plugin action":"Action secret reference must belong to this tenant",
    );
    const stagedReferencePattern=new RegExp(`^${escapePattern(actionSecretReference)}/credentials/[0-9a-f]{64}$`,"u");
    if(input.secretReference?.startsWith(actionSecretPrefix)&&input.secretReference!==actionSecretReference&&!stagedReferencePattern.test(input.secretReference))throw new BadRequestException("Choose the credential staged for this plugin action");
    return this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"ACTION_SAVE",operationIdempotencyKey,
      hash({action:"ACTION_SAVE",input,restoredFromRevision:restoredFromRevision??null}),requestId,async()=>{
      await requirePrivilegedAuthentication(client,principal,"configuring a plugin action endpoint or credential binding");
      if(input.state==="ACTIVE"&&input.secretReference?.startsWith(integrationSecretPrefix)&&!(await client.query("SELECT 1 FROM client_routing_integrations WHERE tenant_id=$1 AND secret_reference=$2 AND provider='NOTION' AND state='CONNECTED'",[principal.tenantId,input.secretReference])).rowCount)throw new BadRequestException("Choose a connected Notion workspace");
      const existing=(await client.query<{id:string;revision:string|number;active_revision_id:string;secret_reference:string|null}>(
        "SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions WHERE tenant_id=$1 AND action_key=$2 FOR UPDATE",
        [principal.tenantId,input.actionKey],
      )).rows[0];
      if(existing&&input.expectedRevision!==Number(existing.revision))throw new ConflictException("Bot action changed; refresh before saving");
      if(!existing&&input.expectedRevision!==null)throw new ConflictException("Bot action no longer exists; refresh before saving");
      if(existing&&(await client.query("SELECT 1 FROM bot_action_jobs WHERE tenant_id=$1 AND action_definition_id=$2 AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1",[principal.tenantId,existing.id])).rowCount)throw new ConflictException("Bot action has pending work and cannot be changed");
      if(existing&&(await client.query(`SELECT 1 FROM bot_flow_versions version
        CROSS JOIN LATERAL jsonb_array_elements(version.definition->'nodes') node
        WHERE version.tenant_id=$1
          AND (version.state='ACTIVE' OR EXISTS (
            SELECT 1 FROM bot_conversations conversation
             WHERE conversation.tenant_id=version.tenant_id
               AND conversation.flow_version_id=version.id
               AND conversation.state<>'RESOLVED'
          ))
          AND node->>'type'='action' AND node->>'actionId'=$2 LIMIT 1`,[principal.tenantId,input.actionKey])).rowCount)throw new ConflictException("Bot action is pinned by an active flow or open conversation; create a new action key and flow version");
      if(existing&&(await client.query(`SELECT 1 FROM trigger_rules rule
        JOIN rule_sets version ON version.tenant_id=rule.tenant_id AND version.id=rule.rule_set_id
        WHERE rule.tenant_id=$1 AND version.state='ACTIVE'
          AND rule.matcher_options->'groupCommand'->>'actionId'=$2 LIMIT 1`,[principal.tenantId,input.actionKey])).rowCount)throw new ConflictException("Bot action is pinned by an active group command; create a new action key and rule-set version");
      const usesVersionedCredential=Boolean(input.secretReference&&stagedReferencePattern.test(input.secretReference));
      const reusesActiveCredential=usesVersionedCredential&&existing?.secret_reference===input.secretReference;
      const stage=usesVersionedCredential&&!reusesActiveCredential
        ?(await client.query<{id:string}>(`SELECT id FROM bot_action_credential_stages
            WHERE tenant_id=$1 AND action_key=$2 AND secret_reference=$3
              AND state='STAGED' AND expires_at>now() FOR UPDATE`,[
            principal.tenantId,input.actionKey,input.secretReference,
          ])).rows[0]
        :undefined;
      if(usesVersionedCredential&&!reusesActiveCredential&&!stage)throw new ConflictException("Plugin credential stage is unavailable or already bound");
      const actionId=existing?.id??randomUUID();
      const revision=existing?Number(existing.revision)+1:1;
      const revisionId=randomUUID();
      const snapshot={name:input.name,kind:input.kind,endpointUrl:input.endpointUrl,httpMethod:input.httpMethod,
        authScheme:input.authScheme,secretReference:input.secretReference,headers:input.headers,responseMapping:input.responseMapping,
        timeoutMs:input.timeoutMs,maxResponseBytes:input.maxResponseBytes,state:input.state};
      if(!existing)await client.query(`INSERT INTO bot_action_definitions
        (id,tenant_id,action_key,name,kind,endpoint_url,http_method,auth_scheme,secret_reference,headers,response_mapping,
         timeout_ms,max_response_bytes,state,revision,active_revision_id,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,[
        actionId,principal.tenantId,input.actionKey,input.name,input.kind,input.endpointUrl,input.httpMethod,input.authScheme,
        input.secretReference,input.headers,input.responseMapping,input.timeoutMs,input.maxResponseBytes,input.state,revision,revisionId,principal.userId,
      ]);
      await client.query(`INSERT INTO bot_action_revisions
        (id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,auth_scheme,secret_reference,
         headers,response_mapping,timeout_ms,max_response_bytes,state,snapshot_sha256,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[
        revisionId,principal.tenantId,actionId,revision,input.name,input.kind,input.endpointUrl,input.httpMethod,input.authScheme,
        input.secretReference,input.headers,input.responseMapping,input.timeoutMs,input.maxResponseBytes,input.state,hash(snapshot),principal.userId,
      ]);
      if(existing)await client.query(`UPDATE bot_action_definitions SET name=$1,kind=$2,endpoint_url=$3,http_method=$4,
        auth_scheme=$5,secret_reference=$6,headers=$7,response_mapping=$8,timeout_ms=$9,max_response_bytes=$10,
        state=$11,revision=$12,active_revision_id=$13,updated_by=$14,updated_at=now()
        WHERE tenant_id=$15 AND id=$16`,[
        input.name,input.kind,input.endpointUrl,input.httpMethod,input.authScheme,input.secretReference,input.headers,input.responseMapping,
        input.timeoutMs,input.maxResponseBytes,input.state,revision,revisionId,principal.userId,principal.tenantId,actionId,
      ]);
      if(stage){const bound=await client.query(`UPDATE bot_action_credential_stages SET state='BOUND',bound_action_revision_id=$1,bound_at=now()
        WHERE tenant_id=$2 AND id=$3 AND state='STAGED' AND expires_at>now()`,[revisionId,principal.tenantId,stage.id]);
        if(bound.rowCount!==1)throw new ConflictException("Plugin credential stage expired; add the credential again")}
      const row={id:actionId,revision};
      if(!row)throw new Error("Bot action could not be saved");
      const result={id:row.id,actionKey:input.actionKey,revision:Number(row.revision),actionRevisionId:revisionId,state:input.state};
      await appendAudit(client,principal,{action:restoredFromRevision?"bot_action.restored":existing?"bot_action.updated":"bot_action.created",targetType:"bot_action",targetId:row.id,requestId,newValue:{...result,kind:input.kind,endpoint_origin:new URL(input.endpointUrl).origin,...(restoredFromRevision?{restored_from_revision:restoredFromRevision}:{})}});
      return result;
    }));
  }

  async qualifyAction(principal:Principal,actionKeyValue:string,idempotencyKey:string,requestId:string,body:unknown){
    const actionKey=actionKeyPath(actionKeyValue);const input=actionQualification(body);const key=operationKey(idempotencyKey);
    const result=await this.database.withTenant(principal.tenantId,async client=>{
      await requirePrivilegedAuthentication(client,principal,"running a plugin action qualification");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`bot-action-qualification:${principal.tenantId}:${key}`]);
      const replay=(await client.query<Record<string,unknown>>(`SELECT job.id,job.state,job.qualification_request_sha256,
        job.action_revision_id,action.action_key,revision.revision AS action_revision FROM bot_action_jobs job
        JOIN bot_action_definitions action ON action.tenant_id=job.tenant_id AND action.id=job.action_definition_id
        JOIN bot_action_revisions revision ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
        WHERE job.tenant_id=$1 AND job.origin='QUALIFICATION' AND job.qualification_idempotency_key=$2`,[principal.tenantId,key])).rows[0];
      if(replay){
        const requestSha256=hash({actionKey,actionRevisionId:replay.action_revision_id,input:input.input});
        if(replay.action_key!==actionKey||Number(replay.action_revision)!==input.expectedRevision||replay.qualification_request_sha256!==requestSha256)throw new ConflictException("Idempotency key was already used for another plugin qualification");
        return{qualificationId:String(replay.id),actionKey,actionRevision:Number(replay.action_revision),state:qualificationState(String(replay.state)),duplicate:true,wake:false};
      }
      const action=(await client.query<{id:string;revision:number|string;active_revision_id:string;kind:string;endpoint_url:string;http_method:string;auth_scheme:string;secret_reference:string|null}>(`SELECT id,revision,active_revision_id,kind,endpoint_url,http_method,auth_scheme,secret_reference
        FROM bot_action_definitions WHERE tenant_id=$1 AND action_key=$2 AND state='ACTIVE' FOR SHARE`,[principal.tenantId,actionKey])).rows[0];
      if(!action)throw new NotFoundException("Active bot action was not found");
      if(Number(action.revision)!==input.expectedRevision)throw new ConflictException("Bot action changed; refresh before qualification");
      if(action.http_method!=="GET"||!supportsBotActionInvocation({kind:action.kind,endpointUrl:action.endpoint_url,httpMethod:action.http_method,authScheme:action.auth_scheme,secretReference:action.secret_reference},"DIRECT_FLOW"))throw new BadRequestException("Only replay-safe GET actions can be qualified");
      const requestSha256=hash({actionKey,actionRevisionId:action.active_revision_id,input:input.input});
      const row=(await client.query<{id:string}>(`INSERT INTO bot_action_jobs
        (tenant_id,origin,action_definition_id,action_revision_id,action_node_id,request_input,on_success_node_id,on_failure_node_id,
         qualification_requested_by,qualification_idempotency_key,qualification_request_sha256)
        VALUES ($1,'QUALIFICATION',$2,$3,'qualification',$4,'qualification','qualification',$5,$6,$7) RETURNING id`,[
        principal.tenantId,action.id,action.active_revision_id,input.input,principal.userId,key,requestSha256,
      ])).rows[0];
      if(!row)throw new Error("Plugin action qualification could not be queued");
      await appendAudit(client,principal,{action:"bot_action.qualification_queued",targetType:"bot_action_qualification",targetId:row.id,requestId,newValue:{action_key:actionKey,action_revision:Number(action.revision)}});
      return{qualificationId:row.id,actionKey,actionRevision:Number(action.revision),state:"QUEUED" as const,duplicate:false,wake:true};
    });
    if(result.wake)await this.drain.wake(principal.tenantId);
    const response={...result};delete (response as {wake?:boolean}).wake;return response;
  }

  async getActionQualification(principal:Principal,actionKeyValue:string,qualificationIdValue:string){
    const actionKey=actionKeyPath(actionKeyValue);const qualificationId=uuid(qualificationIdValue,"Qualification ID");
    const row=(await this.database.rows<Record<string,unknown>>(principal.tenantId,`SELECT job.id,job.state,job.safe_error,
      job.created_at,job.updated_at,job.completed_at,revision.revision AS action_revision
      FROM bot_action_jobs job
      JOIN bot_action_definitions action ON action.tenant_id=job.tenant_id AND action.id=job.action_definition_id
      JOIN bot_action_revisions revision ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
      WHERE job.tenant_id=$1 AND job.id=$2 AND job.origin='QUALIFICATION' AND action.action_key=$3`,[
      principal.tenantId,qualificationId,actionKey,
    ]))[0];
    if(!row)throw new NotFoundException("Plugin action qualification was not found");
    const state=qualificationState(String(row.state));const safeError=typeof row.safe_error==="string"?row.safe_error:undefined;
    const outcome=state==="SUCCEEDED"?"SUCCESS":state==="OUTCOME_UNKNOWN"?"OUTCOME_UNKNOWN":state==="FAILED"?(safeError==="Bot action timed out"?"TIMEOUT":"ERROR"):null;
    return{qualificationId:String(row.id),actionKey,actionRevision:Number(row.action_revision),state,outcome,
      ...(safeError?{safeError}:{}),createdAt:row.created_at,updatedAt:row.updated_at,...(row.completed_at?{completedAt:row.completed_at}:{})};
  }

  create(principal: Principal, idempotencyKey: string, requestId: string, body: unknown) {
    const definition = botFlow(body);
    requireCurrentProviderApproval(definition);
    return this.database.withTenant(principal.tenantId, (client) => this.withOperation(
      client, principal, "CREATE", idempotencyKey,
      hash({ action: "CREATE", definition }), requestId,
      async () => {
        const familyId = (await client.query<{ id: string }>(
          "SELECT app.create_bot_flow_family($1,$2) AS id",
          [definition.name, principal.userId],
        )).rows[0]?.id;
        if (!familyId) throw new Error("Bot flow family could not be persisted");
        const version = await createVersion(client, familyId, definition, null, principal.userId);
        await pinMediaAssets(client,principal.tenantId,version.id,definition);
        const result = { familyId, name: definition.name, ...version };
        await appendAudit(client, principal, { action: "bot_flow.created", targetType: "bot_flow", targetId: version.id, requestId, newValue: result });
        return result;
      },
    ));
  }

  clone(principal: Principal, sourceId: string, idempotencyKey: string, requestId: string, body: unknown) {
    const flowVersionId = uuid(sourceId, "Bot flow version ID");
    const definition = botFlow(body);
    requireCurrentProviderApproval(definition);
    return this.database.withTenant(principal.tenantId, (client) => this.withOperation(
      client, principal, "CLONE", idempotencyKey,
      hash({ action: "CLONE", flowVersionId, definition }), requestId,
      async () => {
        const source = (await client.query<{ family_id: string; definition:unknown }>(
          "SELECT family_id,definition FROM bot_flow_versions WHERE tenant_id=$1 AND id=$2",
          [principal.tenantId, flowVersionId],
        )).rows[0];
        if (!source) throw new NotFoundException("Bot flow version was not found");
        if(source.definition){const previous=botFlow(source.definition);if(isTicketEvent(previous)!==isTicketEvent(definition)||(isTicketEvent(previous)&&isTicketEvent(definition)&&previous.event!==definition.event))throw new BadRequestException("A workflow family must keep its event type");}
        const version = await createVersion(client, source.family_id, definition, flowVersionId, principal.userId);
        await pinMediaAssets(client,principal.tenantId,version.id,definition);
        const result = { familyId: source.family_id, sourceFlowVersionId: flowVersionId, ...version };
        await appendAudit(client, principal, { action: "bot_flow.cloned", targetType: "bot_flow", targetId: version.id, requestId, previousValue: { source_flow_version_id: flowVersionId }, newValue: result });
        return result;
      },
    ));
  }

  activate(principal: Principal, targetId: string, idempotencyKey: string, requestId: string, body: unknown) {
    const flowVersionId = uuid(targetId, "Bot flow version ID");
    const input = activation(body);
    const requestSha256=hash({action:"ACTIVATE",flowVersionId,input});
    return(async()=>{
    const replay=await this.operationReplay(principal,"ACTIVATE",idempotencyKey,requestSha256);if(replay)return replay;
    const prepared=await this.prepareFixedHandoffOwners(principal.tenantId,flowVersionId);
    return this.database.withTenant(principal.tenantId, (client) => this.withOperation(
      client, principal, "ACTIVATE", idempotencyKey,
      requestSha256, requestId,
      async () => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${principal.tenantId}`]);
        const version=(await client.query<{definition:unknown;family_id:string;supersedes_flow_version_id:string|null;snapshot_sha256:string}>("SELECT definition,family_id,supersedes_flow_version_id,snapshot_sha256 FROM bot_flow_versions WHERE tenant_id=$1 AND id=$2",[principal.tenantId,flowVersionId])).rows[0];
        if(!version)throw new NotFoundException("Bot flow version was not found");
        if(hash(version.definition)!==prepared)throw new ConflictException("Bot flow changed; refresh before activation");
        const parsed=botFlow(version.definition);
        if(requiresMeta(parsed)){
          const assignments=await client.query<{provider:string}>(`SELECT connection.provider FROM bot_assignments assignment
            JOIN connections connection ON connection.tenant_id=assignment.tenant_id AND connection.id=assignment.connection_id
            WHERE assignment.tenant_id=$1 AND assignment.flow_family_id=$2 AND assignment.state='ACTIVE'
            FOR SHARE OF assignment,connection`,[principal.tenantId,version.family_id]);
          if(assignments.rows.some(row=>row.provider!=="META"))throw new BadRequestException("Official templates and WhatsApp Flows require official API assignments");
        }
        requireCurrentProviderApproval(parsed);
        await validateMediaAssets(client,principal.tenantId,flowVersionId,parsed);
        if(!isTicketEvent(parsed)){
        const actionIds=[...new Set(parsed.nodes.flatMap(node=>node.type==="action"?[node.actionId]:[]))];
        if(actionIds.length){
          if(version.supersedes_flow_version_id)await client.query(`INSERT INTO automation_action_revision_pins
            (tenant_id,bot_flow_version_id,action_definition_id,action_revision_id)
            SELECT source.tenant_id,$1,source.action_definition_id,source.action_revision_id
            FROM automation_action_revision_pins source
            JOIN bot_flow_versions predecessor
              ON predecessor.tenant_id=source.tenant_id AND predecessor.id=source.bot_flow_version_id
            WHERE source.tenant_id=$2 AND source.bot_flow_version_id=$3
              AND predecessor.snapshot_sha256=$4
            ON CONFLICT DO NOTHING`,[flowVersionId,principal.tenantId,version.supersedes_flow_version_id,version.snapshot_sha256]);
          type ConfiguredAction={id:string;action_key:string;active_revision_id:string;response_mapping:Record<string,string>;kind:string;endpoint_url:string;http_method:string;auth_scheme:string;secret_reference:string|null};
          let configured=(await client.query<ConfiguredAction>(`SELECT action.id,action.action_key,revision.id AS active_revision_id,
              revision.response_mapping,revision.kind,revision.endpoint_url,revision.http_method,revision.auth_scheme,revision.secret_reference
            FROM automation_action_revision_pins pin
            JOIN bot_action_definitions action
              ON action.tenant_id=pin.tenant_id AND action.id=pin.action_definition_id
            JOIN bot_action_revisions revision
              ON revision.tenant_id=pin.tenant_id AND revision.id=pin.action_revision_id
            WHERE pin.tenant_id=$1 AND pin.bot_flow_version_id=$2
              AND action.action_key=ANY($3::text[]) AND revision.state='ACTIVE'`,[principal.tenantId,flowVersionId,actionIds])).rows;
          if(!configured.length){
            configured=(await client.query<ConfiguredAction>(`SELECT id,action_key,active_revision_id,response_mapping,kind,endpoint_url,http_method,auth_scheme,secret_reference
              FROM bot_action_definitions WHERE tenant_id=$1 AND action_key=ANY($2::text[]) AND state='ACTIVE' FOR SHARE`,[principal.tenantId,actionIds])).rows;
            for(const action of configured)await client.query(`INSERT INTO automation_action_revision_pins
              (tenant_id,bot_flow_version_id,action_definition_id,action_revision_id)
              VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[principal.tenantId,flowVersionId,action.id,action.active_revision_id]);
          }
          const missing=actionIds.find(action=>!configured.some(row=>row.action_key===action));
          if(missing)throw new BadRequestException(`Bot action ${missing} is not active`);
          for(const action of configured)if(!supportsBotActionInvocation({kind:action.kind,endpointUrl:action.endpoint_url,httpMethod:action.http_method,authScheme:action.auth_scheme,secretReference:action.secret_reference},"DIRECT_FLOW"))throw new BadRequestException(`Bot action ${action.action_key} is unavailable for direct flows`);
          try{validateBotFlowVariableProvenance(parsed,new Map(configured.map(action=>[action.action_key,Object.keys(action.response_mapping??{})])))}
          catch(error){throw new BadRequestException(error instanceof Error?error.message:"Bot flow variables are invalid")}
        }else{
          try{validateBotFlowVariableProvenance(parsed,new Map())}
          catch(error){throw new BadRequestException(error instanceof Error?error.message:"Bot flow variables are invalid")}
        }
        }
        let row: { active_flow_version_id: string; retired_flow_version_id: string | null; revision: string | number; assignments_migrated: number } | undefined;
        try {
          row = (await client.query<NonNullable<typeof row>>(
            "SELECT * FROM app.activate_bot_flow_version($1,$2,$3,$4)",
            [flowVersionId, input.expectedRevision, input.expectedActiveFlowVersionId, principal.userId],
          )).rows[0];
        } catch (error) {
          if (postgresCode(error) === "40001") throw new ConflictException("Bot flow changed; refresh before activation");
          throw error;
        }
        if (!row) throw new Error("Bot flow activation did not return a result");
        const result = { flowVersionId: row.active_flow_version_id, retiredFlowVersionId: row.retired_flow_version_id, revision: Number(row.revision), assignmentsMigrated: Number(row.assignments_migrated) };
        await appendAudit(client, principal, { action: "bot_flow.activated", targetType: "bot_flow", targetId: flowVersionId, requestId, previousValue: { active_flow_version_id: row.retired_flow_version_id }, newValue: result });
        return result;
      },
    ));
    })();
  }

  assign(principal: Principal, idempotencyKey: string, requestId: string, body: unknown) {
    const input = assignment(body);
    // Old receipts expanded defaults; version new hashes so omission and explicit defaults stay distinct.
    const legacyRequestSha256=hash({action:"ASSIGN",input:{...input,agentPrefix:input.agentPrefix??"Agent:",agentIdentityPlacement:input.agentIdentityPlacement??"HEADER"}});
    const requestSha256=hash({action:"ASSIGN",attributionPolicy:"PRESERVE_OMITTED",input});
    return(async()=>{
    const replay=await this.operationReplay(principal,"ASSIGN",idempotencyKey,requestSha256,legacyRequestSha256);if(replay)return replay;
    const current=(await this.database.withTenant(principal.tenantId,async client=>(await client.query<{id:string}>("SELECT id FROM bot_flow_versions WHERE tenant_id=$1 AND family_id=$2 AND state='ACTIVE'",[principal.tenantId,input.familyId])).rows[0]));
    if(!current)throw new NotFoundException("The active bot flow was not found");
    const prepared=await this.prepareFixedHandoffOwners(principal.tenantId,current.id);
    return this.database.withTenant(principal.tenantId, (client) => this.withOperation(
      client, principal, "ASSIGN", idempotencyKey,
      requestSha256, requestId,
      async () => {
        const target=(await client.query<{provider:"WAHA"|"META";state:string;definition:unknown;flow_version_id:string}>(`SELECT connection.provider,connection.state,version.definition,version.id AS flow_version_id
          FROM connections connection
          JOIN bot_flow_families family ON family.tenant_id=connection.tenant_id AND family.id=$3
          JOIN bot_flow_versions version ON version.tenant_id=family.tenant_id AND version.family_id=family.id AND version.state='ACTIVE'
          WHERE connection.tenant_id=$1 AND connection.id=$2 FOR SHARE OF connection`,[principal.tenantId,input.connectionId,input.familyId])).rows[0];
        if(!target)throw new NotFoundException("The connection or active bot flow was not found");
        if(target.flow_version_id!==current.id||hash(target.definition)!==prepared)throw new ConflictException("Bot flow changed; refresh before assigning it");
        if(target.state!=="WORKING")throw new BadRequestException("The WhatsApp connection must be working before assigning a bot");
        const definition=botFlow(target.definition);
        if(isTicketEvent(definition))throw new BadRequestException("Ticket event workflows must be assigned to a ticket event");
        if(target.provider!=="META"&&requiresMeta(definition))throw new BadRequestException("Official templates and WhatsApp Flows require an official API connection");
        requireCurrentProviderApproval(definition);
        await validateMediaAssets(client,principal.tenantId,target.flow_version_id,definition,target.provider,false);
        let row: { assignment_id: string; flow_version_id: string; revision: number | string } | undefined;
        try { row = (await client.query<NonNullable<typeof row>>(
          "SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)",
          [input.connectionId, input.familyId, input.zammadGroupId, target.flow_version_id, principal.userId],
        )).rows[0]; }
        catch(error){
          if(postgresCode(error)==="23505")throw new ConflictException("This number already has the same active bot assignment");
          if(postgresCode(error)==="40001")throw new ConflictException("Bot flow changed; refresh before assigning it");
          throw error;
        }
        if (!row) throw new Error("Bot flow assignment did not return a result");
        const attribution=(await client.query<{agent_prefix:string;agent_identity_placement:"HEADER"|"FOOTER"|"OFF"}>(`UPDATE bot_assignments
          SET agent_prefix=COALESCE($1,agent_prefix),agent_identity_placement=COALESCE($2,agent_identity_placement)
          WHERE tenant_id=$3 AND id=$4 RETURNING agent_prefix,agent_identity_placement`,[
          input.agentPrefix??null,input.agentIdentityPlacement??null,principal.tenantId,row.assignment_id,
        ])).rows[0];
        if(!attribution)throw new Error("Bot assignment attribution did not return a result");
        const result = { assignmentId: row.assignment_id, flowVersionId: row.flow_version_id, ...input,
          agentPrefix:attribution.agent_prefix,agentIdentityPlacement:attribution.agent_identity_placement,revision: Number(row.revision) };
        await appendAudit(client, principal, { action: "bot_flow.assigned", targetType: "bot_assignment", targetId: row.assignment_id, requestId, newValue: result });
        return result;
      },legacyRequestSha256,
    ));
    })();
  }

  setAssignmentState(principal: Principal, targetId: string, idempotencyKey: string, requestId: string, body: unknown) {
    const assignmentId=uuid(targetId,"Bot assignment ID");
    const input=assignmentState(body);
    const requestSha256=hash({assignmentId,...input});
    return(async()=>{
    const replay=await this.operationReplay(principal,"ASSIGNMENT_STATE",idempotencyKey,requestSha256);if(replay)return replay;
    let preparedVersion:string|undefined;
    if(input.state==="ACTIVE"){
      const current=await this.database.withTenant(principal.tenantId,async client=>(await client.query<{flow_version_id:string}>("SELECT flow_version_id FROM bot_assignments WHERE tenant_id=$1 AND id=$2",[principal.tenantId,assignmentId])).rows[0]);
      if(!current)throw new NotFoundException("Bot assignment was not found");
      preparedVersion=current.flow_version_id;
      await this.prepareFixedHandoffOwners(principal.tenantId,preparedVersion);
    }
    return this.database.withTenant(principal.tenantId,async client=>{
      return this.withOperation(client,principal,"ASSIGNMENT_STATE",idempotencyKey,requestSha256,requestId,async()=>{
        if(preparedVersion){const current=(await client.query<{flow_version_id:string}>("SELECT flow_version_id FROM bot_assignments WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[principal.tenantId,assignmentId])).rows[0];if(current?.flow_version_id!==preparedVersion)throw new ConflictException("Bot assignment changed; refresh before updating it");}
        const row=(await client.query<{id:string;state:string;revision:string|number}>(`UPDATE bot_assignments assignment SET state=$1,revision=assignment.revision+1,
          updated_by=$2,updated_at=now() FROM connections connection
          WHERE assignment.tenant_id=$3 AND assignment.id=$4 AND assignment.revision=$5 AND assignment.state<>$1
            AND connection.tenant_id=assignment.tenant_id AND connection.id=assignment.connection_id
            AND ($1='PAUSED' OR connection.state='WORKING') RETURNING assignment.id,assignment.state,assignment.revision`,[
          input.state,principal.userId,principal.tenantId,assignmentId,input.expectedRevision,
        ])).rows[0];
        if(!row)throw new ConflictException("Bot assignment changed; refresh before updating it");
        const result={assignmentId:row.id,state:row.state,revision:Number(row.revision)};
        await appendAudit(client,principal,{action:row.state==="PAUSED"?"bot_assignment.paused":"bot_assignment.resumed",targetType:"bot_assignment",targetId:row.id,requestId,newValue:result});
        return result;
      });
    });
    })();
  }

  setAssignmentAttribution(principal:Principal,targetId:string,idempotencyKey:string,requestId:string,body:unknown){
    const assignmentId=uuid(targetId,"Bot assignment ID");const input=assignmentAttribution(body);
    return this.database.withTenant(principal.tenantId,client=>this.withOperation(client,principal,"ASSIGNMENT_ATTRIBUTION",idempotencyKey,
      hash({assignmentId,...input}),requestId,async()=>{
        const row=(await client.query<{id:string;agent_prefix:string;agent_identity_placement:"HEADER"|"FOOTER"|"OFF";revision:string|number}>(`UPDATE bot_assignments assignment
          SET agent_prefix=$1,agent_identity_placement=$2,revision=assignment.revision+1,updated_by=$3,updated_at=now()
          WHERE assignment.tenant_id=$4 AND assignment.id=$5 AND assignment.revision=$6
            AND (assignment.agent_prefix<>$1 OR assignment.agent_identity_placement<>$2)
          RETURNING assignment.id,assignment.agent_prefix,assignment.agent_identity_placement,assignment.revision`,[
          input.agentPrefix,input.agentIdentityPlacement,principal.userId,principal.tenantId,assignmentId,input.expectedRevision,
        ])).rows[0];
        if(!row)throw new ConflictException("Bot assignment changed; refresh before updating its message attribution");
        const result={assignmentId:row.id,agentPrefix:row.agent_prefix,agentIdentityPlacement:row.agent_identity_placement,revision:Number(row.revision)};
        await appendAudit(client,principal,{action:"bot_assignment.attribution_updated",targetType:"bot_assignment",targetId:row.id,requestId,newValue:{agent_prefix:row.agent_prefix,agent_identity_placement:row.agent_identity_placement,revision:result.revision}});
        return result;
      }));
  }

  private operationReplay(principal:Principal,action:OperationAction,key:string,requestSha256:string,legacyRequestSha256?:string){
    return this.database.withTenant(principal.tenantId,client=>findOperationReceipt(client,principal,action,key,requestSha256,
      "Idempotency key was already used for another bot operation",legacyRequestSha256));
  }

  private async prepareFixedHandoffOwners(tenantId:string,versionId:string){
    const version=await this.database.withTenant(tenantId,async client=>(await client.query<{definition:unknown}>("SELECT definition,family_id,supersedes_flow_version_id,snapshot_sha256 FROM bot_flow_versions WHERE tenant_id=$1 AND id=$2",[tenantId,versionId])).rows[0]);
    if(!version)throw new NotFoundException("Bot flow version was not found");
    const definition=botFlow(version.definition);
    if(!isTicketEvent(definition)){
      const targets=definition.nodes.filter(node=>node.type==="handoff"&&node.target==="FIXED"&&node.zammadOwnerId);
      if(targets.length){
        const catalog=await this.catalogs.get(tenantId,true);
        for(const node of targets)if(node.type==="handoff"&&node.target==="FIXED"){
          const group=catalog.groups.find(item=>item.id===node.zammadGroupId),owner=catalog.owners.find(item=>item.id===node.zammadOwnerId);
          if(!group?.active||!group.serviceIdentityCanCreate||!owner?.active||!owner.groupIds.includes(node.zammadGroupId))throw new BadRequestException({code:"NATIVE_ROUTING_VALIDATION_ERROR",message:"The fixed handoff needs an active queue and eligible agent"});
        }
      }
    }
    return hash(version.definition);
  }

  private async withOperation(client: PoolClient, principal: Principal, action: OperationAction, idempotencyKey: string, requestSha256: string, requestId: string, operation: () => Promise<Record<string, unknown>>,legacyRequestSha256?:string) {
    return withOperationReceipt(client,principal,action,idempotencyKey,requestSha256,requestId,operation,
      "Idempotency key was already used for another bot operation",legacyRequestSha256);
  }
}

async function createVersion(client: PoolClient, familyId: string, definition: WorkflowDefinition, sourceId: string | null, userId: string) {
  const row = (await client.query<{ id: string; version: number | string; state: string; revision: number | string; snapshot_sha256: string }>(
    "SELECT * FROM app.create_bot_flow_version($1,$2,$3,$4)",
    [familyId, definition, sourceId, userId],
  )).rows[0];
  if (!row) throw new Error("Bot flow version could not be persisted");
  return { id: row.id, version: Number(row.version), state: row.state, revision: Number(row.revision), snapshotSha256: row.snapshot_sha256 };
}

function botFlow(value: unknown) {
  try { return value&&typeof value==="object"&&"kind" in value&&value.kind==="TICKET_EVENT"?parseTicketEventFlow(value):parseBotFlow(value); }
  catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Bot flow is invalid"); }
}

function requiresMeta(definition:WorkflowDefinition){return definition.nodes.some(node=>node.type==="send_template"||node.type==="whatsapp_flow")}

function requireCurrentProviderApproval(definition:WorkflowDefinition){
  const capabilities=directMessageCapabilities("meta");
  if(definition.nodes.some(node=>(node.type==="send_template"&&!capabilities.templates)||(node.type==="whatsapp_flow"&&!capabilities.metaFlows)))
    throw new BadRequestException("Official templates and WhatsApp Flows require current provider approval");
}

function mediaAssetInput(value:unknown){
  const body=object(value,"Media asset");const filename=safeMediaFilename(boundedText(body.filename,"File name",120));
  const mimeType=normalizeMediaMime(boundedText(body.mimeType,"Media type",127));const maximum=maximumMediaBytes(mimeType);
  const byteSize=boundedNumber(body.byteSize,1,100_000_000,"Media size");
  const contentSha256=boundedText(body.contentSha256,"Media content digest",64);if(!/^[0-9a-f]{64}$/u.test(contentSha256))throw new BadRequestException("Media content digest is invalid");
  if(!maximum||byteSize>maximum)throw new BadRequestException("This media type or file size is not supported");
  return{filename,mimeType,byteSize,contentSha256};
}

function mediaAssetIds(definition:WorkflowDefinition){return[...new Set(definition.nodes.flatMap(node=>node.type==="send_media"?[node.assetId]:[]))]}

async function pinMediaAssets(client:PoolClient,tenantId:string,flowVersionId:string,definition:WorkflowDefinition){
  const assetIds=mediaAssetIds(definition);if(!assetIds.length)return;
  const rows=(await client.query<{id:string}>(`SELECT id FROM bot_media_assets WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND state='READY' FOR SHARE`,[tenantId,assetIds])).rows;
  const missing=assetIds.find(id=>!rows.some(row=>row.id===id));if(missing)throw new BadRequestException("A selected media file is not ready");
  await client.query(`INSERT INTO bot_flow_media_asset_pins (tenant_id,bot_flow_version_id,bot_media_asset_id)
    SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING`,[tenantId,flowVersionId,assetIds]);
}

async function validateMediaAssets(client:PoolClient,tenantId:string,flowVersionId:string,definition:WorkflowDefinition,provider?:"WAHA"|"META",requireUnexpired=true){
  const assetIds=mediaAssetIds(definition);if(!assetIds.length)return;
  const rows=(await client.query<{id:string;mime_type:string;byte_size:string|number}>(`SELECT asset.id,asset.mime_type,asset.byte_size FROM bot_flow_media_asset_pins pin
    JOIN bot_media_assets asset ON asset.tenant_id=pin.tenant_id AND asset.id=pin.bot_media_asset_id
    JOIN media_objects media ON media.tenant_id=asset.tenant_id AND media.id=asset.media_object_id
    WHERE pin.tenant_id=$1 AND pin.bot_flow_version_id=$2 AND asset.state='READY' AND ($3::boolean=false OR media.expires_at>now()) FOR SHARE OF asset,media`,[tenantId,flowVersionId,requireUnexpired])).rows;
  const missing=assetIds.find(id=>!rows.some(row=>row.id===id));if(missing)throw new BadRequestException("A selected media file is unavailable");
  let providers=provider?[provider]:(await client.query<{provider:"WAHA"|"META"}>(`SELECT DISTINCT connection.provider FROM bot_assignments assignment
    JOIN bot_flow_versions version ON version.tenant_id=assignment.tenant_id AND version.family_id=assignment.flow_family_id
    JOIN connections connection ON connection.tenant_id=assignment.tenant_id AND connection.id=assignment.connection_id
    WHERE assignment.tenant_id=$1 AND version.id=$2 AND assignment.state='ACTIVE'`,[tenantId,flowVersionId])).rows.map(row=>row.provider);
  providers=[...new Set(providers)];
  for(const current of providers)for(const asset of rows){const rule=providerOutboundMediaRule(current,asset.mime_type);if(!rule||Number(asset.byte_size)>rule.maximumBytes)throw new BadRequestException(`A selected media file is not supported by ${current==='META'?'the official API':'the linked WhatsApp connection'}`)}
}

function clientRouting(value:unknown){
  try{return parseClientRouting(value)}catch(error){throw new BadRequestException(error instanceof Error?error.message:"Client routing is invalid")}
}

function routingActivation(value:unknown){
  const body=object(value,"Client routing activation request");
  const expectedRevision=boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected revision");
  const active=body.expectedActiveRoutingVersionId;if(active!==null&&active!==undefined)uuid(active,"Expected active client routing version ID");
  return{expectedRevision,expectedActiveRoutingVersionId:active==null?null:String(active)};
}

function routingSourceSync(value:unknown){const body=object(value,"Routing source sync request");return{expectedSnapshotRevision:boundedNumber(body.expectedSnapshotRevision,0,Number.MAX_SAFE_INTEGER,"Expected snapshot revision")}}

function routingOAuthStart(value:unknown){const body=object(value??{},"Notion authorization request");return{integrationId:body.integrationId==null?undefined:uuid(body.integrationId,"Integration ID")}}

function routingOAuthCallback(value:unknown){const body=object(value,"Notion authorization callback");const state=boundedText(body.state,"OAuth state",128);const code=boundedText(body.code,"Notion authorization code",2048);if(!/^[A-Za-z0-9_-]{43}$/u.test(state))throw new BadRequestException("Notion authorization state is invalid");if(Array.from(code).some(character=>{const value=character.codePointAt(0)??0;return value<32||value===127}))throw new BadRequestException("Notion authorization code is invalid");return{state,code}}

function routingOAuthAbort(value:unknown){const body=object(value,"Notion authorization cancellation");const state=boundedText(body.state,"OAuth state",128);if(!/^[A-Za-z0-9_-]{43}$/u.test(state))throw new BadRequestException("Notion authorization state is invalid");if(body.reason!=="DENIED"&&body.reason!=="FAILED")throw new BadRequestException("Notion authorization cancellation reason is invalid");return{state,reason:body.reason}}

function routingCredential(value:unknown){
  const body=object(value,"Routing credential");
  if(body.provider!=="ZOHO"&&body.provider!=="HTTP_JSON")throw new BadRequestException("Routing credential provider is invalid");
  const provider=body.provider;const displayName=boundedText(body.displayName,"Routing credential name",160);
  if(body.authScheme!=="BEARER"&&body.authScheme!=="HMAC")throw new BadRequestException("Routing credential authentication is invalid");
  const authScheme=body.authScheme;if(provider==="ZOHO"&&authScheme!=="BEARER")throw new BadRequestException("Zoho routing credentials require bearer authentication");
  const credential=boundedText(body.credential,"Routing credential",4_096);
  if(credential.length<16)throw new BadRequestException("Routing credential is invalid");
  const integrationId=body.integrationId==null?null:uuid(body.integrationId,"Routing integration ID");
  const expectedRevision=body.expectedRevision==null?null:boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected routing credential revision");
  if((integrationId===null)!==(expectedRevision===null))throw new BadRequestException("Routing credential revision is invalid");
  return{provider,displayName,authScheme,credential,integrationId,expectedRevision};
}

function routingCredentialTest(value:unknown){const body=object(value,"Routing credential test");return{expectedRevision:boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected routing credential revision")}}
function routingSourceQualification(value:unknown){const body=object(value,"Routing source qualification");return{
  integrationId:uuid(body.integrationId,"Routing integration ID"),
  expectedIntegrationRevision:boundedNumber(body.expectedIntegrationRevision,1,Number.MAX_SAFE_INTEGER,"Expected routing integration revision"),
  expectedRoutingRevision:boundedNumber(body.expectedRoutingRevision,1,Number.MAX_SAFE_INTEGER,"Expected routing version revision"),
}}

async function exchangeNotionCode(code:string,redirectUri:string,clientId:string,clientSecret:string){let response:Response;try{response=await fetch("https://api.notion.com/v1/oauth/token",{method:"POST",headers:{authorization:`Basic ${Buffer.from(`${clientId}:${clientSecret}`,"utf8").toString("base64")}`,"content-type":"application/json",accept:"application/json","notion-version":"2026-03-11"},body:JSON.stringify({grant_type:"authorization_code",code,redirect_uri:redirectUri}),redirect:"error",signal:AbortSignal.timeout(10_000)})}catch{throw new ServiceUnavailableException("Notion authorization is temporarily unavailable. Try again.")}
  if(response.status>=500||response.status===429)throw new ServiceUnavailableException("Notion authorization is temporarily unavailable. Try again.");if(!response.ok)throw new BadRequestException("Notion did not authorize this workspace. Connect again.");if(!(response.headers.get("content-type")??"").toLowerCase().startsWith("application/json"))throw new ServiceUnavailableException("Notion returned an invalid authorization response");let value:unknown;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedResponse(response,65_536)))}catch{throw new ServiceUnavailableException("Notion returned an invalid authorization response")};if(!value||typeof value!=="object"||Array.isArray(value))throw new ServiceUnavailableException("Notion returned an invalid authorization response");const token=value as Record<string,unknown>;const accessToken=typeof token.access_token==="string"?token.access_token:"";const refreshToken=typeof token.refresh_token==="string"?token.refresh_token:undefined;const workspaceId=typeof token.workspace_id==="string"?token.workspace_id:"";const workspaceName=typeof token.workspace_name==="string"&&token.workspace_name.trim()?token.workspace_name.trim():"Notion workspace";if(accessToken.length<16||accessToken.length>4096||refreshToken&&refreshToken.length>4096||!/^[0-9a-f-]{36}$/iu.test(workspaceId)||workspaceName.length>160)throw new ServiceUnavailableException("Notion returned an invalid authorization response");return{accessToken,refreshToken,workspaceId,workspaceName}}

async function readBoundedResponse(response:Response,limit:number){if(!response.body)throw new Error("empty response");const reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;try{for(;;){const{done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel().catch(()=>undefined);throw new Error("response too large")}chunks.push(value)}}finally{reader.releaseLock()}const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}return result}

function routingSimulation(value:unknown){
  const body=object(value,"Client routing simulation");const version=body.versionId;
  if(version!==null&&version!==undefined)uuid(version,"Client routing version ID");
  const match=object(body.match??{},"Client routing simulation match");
  const optional=(key:string,maximum:number)=>match[key]===undefined||match[key]===null||match[key]===""?undefined:boundedText(match[key],`Routing ${key}`,maximum);
  return{versionId:version==null?null:String(version),match:{
    ...(optional("connectionId",36)?{connectionId:uuid(optional("connectionId",36),"Routing connection ID")}:{ }),
    ...(optional("whatsappGroupId",512)?{whatsappGroupId:optional("whatsappGroupId",512)}:{}),
    ...(optional("identifier",512)?{identifier:optional("identifier",512)}:{}),
    ...(optional("identifierNamespace",80)?{identifierNamespace:optional("identifierNamespace",80)}:{}),
    ...(optional("email",320)?{email:optional("email",320)}:{}),
    ...(optional("entryGroupId",16)?{entryGroupId:optional("entryGroupId",16)}:{}),
  } satisfies ClientRoutingInput};
}

function redactRoutingSecrets(value:unknown){
  const definition=clientRouting(value);return{...definition,sources:definition.sources.map(source=>({...source,...(source.endpointUrl?{endpointUrl:redactEndpointQuery(source.endpointUrl)}:{}),...(source.secretReference?{secretReference:"secret://redacted/routing/configured"}:{})}))};
}

function redactEndpointQuery(value:unknown){if(typeof value!=="string")return value;const url=new URL(value);url.search="";return url.href}

function assertTenantRoutingSecrets(definition:ClientRoutingDefinition,tenantId:string){
  for(const source of definition.sources){
    if(source.kind==="MANUAL")continue;
    if(!source.secretReference||!isOwnedSecretReference(source.secretReference,{kind:"routing",tenantId})){
      throw new BadRequestException(`${source.id} secret reference must belong to this tenant's routing namespace`);
    }
  }
}

function activation(value: unknown) {
  const body = object(value, "Activation request");
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw new BadRequestException("expectedRevision is invalid");
  const expectedActive = body.expectedActiveFlowVersionId;
  if (expectedActive !== null && expectedActive !== undefined) uuid(expectedActive, "Expected active bot flow version ID");
  return { expectedRevision: Number(body.expectedRevision), expectedActiveFlowVersionId: expectedActive == null ? null : String(expectedActive) };
}

function assignment(value: unknown) {
  const body = object(value, "Assignment request");
  return { connectionId: uuid(body.connectionId, "Connection ID"), familyId: uuid(body.familyId, "Bot flow family ID"), zammadGroupId: boundedText(body.zammadGroupId, "Zammad group ID", 80),agentPrefix:body.agentPrefix===undefined?undefined:boundedText(body.agentPrefix,"Agent prefix",80),agentIdentityPlacement:body.agentIdentityPlacement===undefined?undefined:agentIdentityPlacement(body.agentIdentityPlacement) };
}

function assignmentState(value:unknown){const body=object(value,"Assignment state request");if(body.state!=="ACTIVE"&&body.state!=="PAUSED")throw new BadRequestException("Assignment state is invalid");return{state:body.state,expectedRevision:boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected revision")}}
function assignmentAttribution(value:unknown){const body=object(value,"Assignment attribution request");return{agentPrefix:boundedText(body.agentPrefix,"Agent prefix",80),agentIdentityPlacement:agentIdentityPlacement(body.agentIdentityPlacement),expectedRevision:boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected revision")}}
function agentIdentityPlacement(value:unknown):"HEADER"|"FOOTER"|"OFF"{if(value===undefined)return"HEADER";if(value!=="HEADER"&&value!=="FOOTER"&&value!=="OFF")throw new BadRequestException("Agent identity placement is invalid");return value}

function conversationPageLimit(value:unknown){
  if(typeof value!=="string"||!/^[1-9][0-9]{0,2}$/u.test(value))throw new BadRequestException("Conversation page limit is invalid");
  const limit=Number(value);
  if(limit>CONVERSATION_PAGE_MAX)throw new BadRequestException("Conversation page limit is invalid");
  return limit;
}

function catalogPageLimit(value:string|undefined){
  if(value===undefined)return 50;
  if(!/^[1-9][0-9]{0,2}$/u.test(value)||Number(value)>CATALOG_PAGE_MAX)throw new BadRequestException("Catalog page limit is invalid");
  return Number(value);
}

function decodeCursor(value:unknown):unknown{
  if(typeof value!=="string"||value.length>1024||!/^[-_A-Za-z0-9]+$/u.test(value))throw new Error("invalid encoding");
  const bytes=Buffer.from(value,"base64url");
  if(bytes.toString("base64url")!==value)throw new Error("non-canonical encoding");
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
}

function catalogCursor(value:unknown,tenantId:string,kind:CatalogKind):CatalogCursor|null{
  if(value===undefined)return null;
  try{
    const parsed=decodeCursor(value) as Partial<CatalogCursor>;
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.keys(parsed).sort().join(",")!=="id,kind,sort,tenant,v"
      ||parsed.v!==1||parsed.tenant!==tenantId||parsed.kind!==kind||typeof parsed.sort!=="string"||parsed.sort.length<1||parsed.sort.length>256||typeof parsed.id!=="string")throw new Error("invalid payload");
    uuid(parsed.id,"Catalog cursor ID");
    if(kind==="FLOW"){
      const parts=parsed.sort.split("\u001f");if(parts.length!==2||!parts[0]||!/^[1-9][0-9]*$/u.test(parts[1]??""))throw new Error("invalid flow cursor");
    }else if(kind==="ROUTING"&&!/^[1-9][0-9]*$/u.test(parsed.sort))throw new Error("invalid routing cursor");
    return parsed as CatalogCursor;
  }catch{throw new BadRequestException("Catalog cursor is invalid")}
}

function catalogPage<T extends Record<string,unknown>>(rows:T[],limit:number,tenantId:string,kind:CatalogKind,sort:(row:T)=>string,id:(row:T)=>string){
  const pageRows=rows.slice(0,limit);const items=pageRows.map(row=>{const item={...row};delete item.pagination_sort;return item});
  const last=pageRows.at(-1);const next_cursor=rows.length>limit&&last?Buffer.from(JSON.stringify({v:1,tenant:tenantId,kind,sort:sort(last),id:uuid(id(last),"Catalog item ID")} satisfies CatalogCursor),"utf8").toString("base64url"):null;
  return{items,next_cursor};
}

function conversationCursor(value:unknown,tenantId:string):ConversationCursor|null{
  if(value===undefined)return null;
  try{
    const parsed=decodeCursor(value);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("invalid payload");
    const cursor=parsed as Partial<ConversationCursor>;
    if(Object.keys(cursor).sort().join(",")!=="at,id,tenant,v"||cursor.v!==1||cursor.tenant!==tenantId||typeof cursor.at!=="string"||typeof cursor.id!=="string")throw new Error("invalid payload");
    if(!validConversationTimestamp(cursor.at))throw new Error("invalid timestamp");
    uuid(cursor.id,"Conversation cursor ID");
    return cursor as ConversationCursor;
  }catch{
    throw new BadRequestException("Conversation cursor is invalid");
  }
}

function encodeConversationCursor(tenantId:string,row:ConversationRow){
  if(!validConversationTimestamp(row.pagination_activity_at))throw new Error("Conversation activity timestamp is invalid");
  const cursor:ConversationCursor={v:1,tenant:tenantId,at:row.pagination_activity_at,id:uuid(row.id,"Conversation ID")};
  return Buffer.from(JSON.stringify(cursor),"utf8").toString("base64url");
}

function conversationEventCursor(value:unknown,tenantId:string,conversationId:string):ConversationEventCursor|null{
  if(value===undefined)return null;
  try{
    const parsed=decodeCursor(value);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("invalid payload");
    const cursor=parsed as Partial<ConversationEventCursor>;
    if(Object.keys(cursor).sort().join(",")!=="at,conversation,id,tenant,v"||cursor.v!==1||cursor.tenant!==tenantId||cursor.conversation!==conversationId||typeof cursor.at!=="string"||typeof cursor.id!=="string")throw new Error("invalid payload");
    if(!validConversationTimestamp(cursor.at))throw new Error("invalid timestamp");
    uuid(cursor.id,"Conversation event cursor ID");
    return cursor as ConversationEventCursor;
  }catch{throw new BadRequestException("Conversation event cursor is invalid")}
}

function encodeConversationEventCursor(tenantId:string,conversationId:string,row:ConversationEventRow){
  if(!validConversationTimestamp(row.pagination_created_at))throw new Error("Conversation event timestamp is invalid");
  const cursor:ConversationEventCursor={v:1,tenant:tenantId,conversation:conversationId,at:row.pagination_created_at,id:uuid(row.id,"Conversation event ID")};
  return Buffer.from(JSON.stringify(cursor),"utf8").toString("base64url");
}

function validConversationTimestamp(value:string){
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/u.exec(value);
  if(!match)return false;
  const [year,month,day,hour,minute,second,microsecond]=match.slice(1).map(Number) as [number,number,number,number,number,number,number];
  if(year<1)return false;
  const timestamp=new Date(0);
  timestamp.setUTCFullYear(year,month-1,day);
  timestamp.setUTCHours(hour,minute,second,Math.floor(microsecond/1000));
  return timestamp.getUTCFullYear()===year&&timestamp.getUTCMonth()===month-1&&timestamp.getUTCDate()===day&&timestamp.getUTCHours()===hour&&timestamp.getUTCMinutes()===minute&&timestamp.getUTCSeconds()===second&&timestamp.getUTCMilliseconds()===Math.floor(microsecond/1000);
}

function conversationCommand(value:unknown){const body=object(value,"Bot conversation command");if(body.action!=="RETRY_HANDOFF"&&body.action!=="RETRY_ACTION"&&body.action!=="HANDOFF_TO_HUMAN"&&body.action!=="RESUME_BOT"&&body.action!=="CLOSE")throw new BadRequestException("Bot conversation command is invalid");return{action:body.action,expectedFencingToken:boundedNumber(body.expectedFencingToken,0,Number.MAX_SAFE_INTEGER,"Expected fencing token")}}

function actionDefinition(value:unknown){
  const body=object(value,"Bot action");
  const actionKey=boundedText(body.actionKey,"Action key",128);
  if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(actionKey))throw new BadRequestException("Action key is invalid");
  const name=boundedText(body.name,"Action name",160);
  const kind=body.kind;
  if(kind!=="HTTP_JSON"&&kind!=="NOTION_CREATE_PAGE")throw new BadRequestException("Action kind is invalid");
  const httpMethod=body.httpMethod;
  if(httpMethod!=="GET"&&httpMethod!=="POST")throw new BadRequestException("Action HTTP method is invalid");
  const authScheme=body.authScheme;
  if(authScheme!=="NONE"&&authScheme!=="BEARER")throw new BadRequestException("Action authentication is invalid");
  let endpoint:URL;
  try{endpoint=new URL(String(body.endpointUrl??""))}catch{throw new BadRequestException("Action endpoint is invalid")}
  if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.hash||hasCredentialQueryParameter(endpoint)||endpoint.href.length>2048)throw new BadRequestException("Action endpoint must be a credential-free HTTPS URL without credential query parameters");
  if(kind==="NOTION_CREATE_PAGE"&&(endpoint.origin!=="https://api.notion.com"||endpoint.pathname!=="/v1/pages"||httpMethod!=="POST"||authScheme!=="BEARER"))throw new BadRequestException("Notion actions must use the official create-page endpoint with bearer authentication");
  const secretReference=body.secretReference==null?null:boundedText(body.secretReference,"Secret reference",512);
  if((authScheme==="NONE")!== (secretReference===null)||secretReference!==null&&!/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(secretReference))throw new BadRequestException("Action secret reference is invalid");
  const headers=stringMap(body.headers,"Action headers",25,200);
  for(const key of Object.keys(headers))if(["host","content-length","connection","transfer-encoding"].includes(key.toLowerCase())||/(?:authorization|cookie|token|secret|credential|api[-_]?key)/iu.test(key))throw new BadRequestException(`Action header ${key} is reserved`);
  const responseMapping=stringMap(body.responseMapping,"Action response mapping",25,500);
  for(const [key,pointer] of Object.entries(responseMapping))if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(key)||!/^\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer))throw new BadRequestException("Action response mapping is invalid");
  const timeoutMs=boundedNumber(body.timeoutMs,1000,10000,"Action timeout");
  const maxResponseBytes=boundedNumber(body.maxResponseBytes,1024,1048576,"Action response limit");
  if(body.state!=="ACTIVE"&&body.state!=="PAUSED")throw new BadRequestException("Action state is invalid");
  const expectedRevision=body.expectedRevision===null||body.expectedRevision===undefined?null:boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected revision");
  return{actionKey,name,kind,endpointUrl:endpoint.href,httpMethod,authScheme,secretReference,headers,responseMapping,timeoutMs,maxResponseBytes,state:body.state,expectedRevision};
}

function actionCredential(value:unknown){
  const body=object(value,"Action credential");
  const actionKey=boundedText(body.actionKey,"Action key",128);
  if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(actionKey))throw new BadRequestException("Action key is invalid");
  const credential=boundedText(body.credential,"Action credential",4_096);
  if(credential.length<16||Array.from(credential).some(character=>{const code=character.codePointAt(0)??0;return code<32||code===127}))throw new BadRequestException("Action credential is invalid");
  return{actionKey,credential};
}

function actionQualification(value:unknown){
  const body=object(value,"Action qualification");
  const expectedRevision=boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected action revision");
  const input=stringMap(body.input??{},"Action qualification input",25,2_000);
  return{expectedRevision,input};
}

function actionRestore(value:unknown){const body=object(value,"Action restore");return{expectedRevision:boundedNumber(body.expectedRevision,1,Number.MAX_SAFE_INTEGER,"Expected action revision")}}

function actionKeyPath(value:unknown){const actionKey=boundedText(value,"Action key",128);if(!/^[a-z][a-z0-9_.-]{0,127}$/u.test(actionKey))throw new BadRequestException("Action key is invalid");return actionKey}

function qualificationState(value:string){
  if(value==="QUEUED"||value==="FAILED_RETRYABLE")return"QUEUED" as const;
  if(value==="RUNNING")return"RUNNING" as const;
  if(value==="SUCCEEDED")return"SUCCEEDED" as const;
  if(value==="OUTCOME_UNKNOWN")return"OUTCOME_UNKNOWN" as const;
  return"FAILED" as const;
}

function escapePattern(value:string){return value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&")}

function stringMap(value:unknown,label:string,maximumEntries:number,maximumValue:number){
  const map=object(value??{},label);const entries=Object.entries(map);
  if(entries.length>maximumEntries)throw new BadRequestException(`${label} has too many entries`);
  return Object.fromEntries(entries.map(([key,item])=>[boundedText(key,`${label} key`,128),boundedText(item,`${label} value`,maximumValue)]));
}

function boundedNumber(value:unknown,minimum:number,maximum:number,label:string){if(!Number.isSafeInteger(value)||Number(value)<minimum||Number(value)>maximum)throw new BadRequestException(`${label} is invalid`);return Number(value)}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string) {
  const result = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result)) throw new BadRequestException(`${label} must be a UUID`);
  return result;
}

function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || [...value].length > maximum || hasControl(value)) throw new BadRequestException(`${label} is invalid`);
  return value;
}

const operationKey=requireOperationKey;

function hasControl(value:string){return[...value].some(character=>{const code=character.codePointAt(0)!;return code===127||code<32})}

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function postgresCode(error: unknown) { return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : ""; }
