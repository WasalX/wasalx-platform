import { createHash } from "node:crypto";
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { PoolClient } from "pg";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import type { AuthenticatedRequest } from "./types.js";
import { ZammadRoutingCatalogService } from "./zammad-routing-catalog.service.js";
import { requireOperationKey, withOperationReceipt } from "./idempotent-operation.js";
import { loadEffectiveTicketEvent } from "@wasalx/core/ticket-event-runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIORITIES = new Set(["low", "normal", "high"]);
const ASSIGNMENT_MODES = new Set(["zammad_auto", "fixed_owner", "unassigned"]);
const BINDING_STATES = new Set(["DRAFT", "ACTIVE", "PAUSED"]);
const BUSINESS_HOURS_MODES = new Set(["ALWAYS", "ZAMMAD_CALENDAR"]);
const AGENT_IDENTITY_PLACEMENTS = new Set(["HEADER", "FOOTER", "OFF"]);

type BindingInput = {
  displayName?: string;
  ruleSetId?: string;
  zammadGroupId?: string;
  defaultPriority?: string;
  assignmentMode?: string;
  fixedOwnerId?: string;
  slaPolicyId?: string;
  businessHoursMode?: string;
  businessHoursCalendarId?: string;
  acknowledgementTemplate?: string;
  agentPrefix?: string;
  agentIdentityPlacement?: string;
  maxIdentifiers?: number;
  mediaEnabled?: boolean;
  retentionDays?: number;
  state?: string;
  expectedRevision?: number;
};

type ActivationReadiness = {
  group_id: string;
  binding_id: string | null;
  provider: string;
  connection_state: string;
  sync_state: string;
  last_synced_at: string | Date | null;
  webhook_route_state: string | null;
  zammad_state: string | null;
  rule_set_state: string | null;
  enabled_rule_count: string;
  working_session_count: string;
  pending_operation_count: string;
  designated_binding_conflicts?: string;
  waha_worker_ready_count: string;
  zammad_group_id: string | null;
  assignment_mode: string | null;
  fixed_owner_id: string | null;
  sla_policy_id: string | null;
  business_hours_mode: string | null;
  business_hours_calendar_id: string | null;
};

@Controller("v1/groups")
export class GroupsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly catalogs: ZammadRoutingCatalogService,
  ) {}

  @Get()
  @Requires("group:read")
  async list(@Req() request: AuthenticatedRequest, @Query("after") after?: string, @Query("limit") limitValue?: string,
    @Query("q") queryValue?: string, @Query("connection") connectionId?: string) {
    if (after !== undefined && !UUID.test(after)) throw new BadRequestException("Group cursor is invalid");
    if (connectionId !== undefined && !UUID.test(connectionId)) throw new BadRequestException("Connection filter is invalid");
    const query=queryValue?.trim();
    if (query && [...query].length>160) throw new BadRequestException("Group search is too long");
    const limit = boundedListLimit(limitValue, "Group");
    const rows=await this.database.rows<Record<string,unknown>&{id:string}>(
      request.principal.tenantId,
      `WITH cursor AS (
         SELECT COALESCE(wasalx_name,display_name) AS display_name,id
           FROM whatsapp_groups WHERE tenant_id=$1 AND id=$2
       ) SELECT g.id,
              g.connection_id,
              g.external_group_id,
              COALESCE(g.wasalx_name, g.display_name) AS display_name,
              g.display_name AS provider_display_name,
              g.wasalx_name,
              CASE WHEN g.participant_count_known THEN g.participant_count ELSE NULL END AS participant_count,
              g.last_synced_at,
              b.id AS binding_id,
              b.rule_set_id,
              b.zammad_group_id,
              b.default_priority,
              b.assignment_mode,
              b.fixed_owner_id,
              b.sla_policy_id,
              b.business_hours_mode,
              b.business_hours_calendar_id,
              b.acknowledgement_template,
              b.agent_prefix,
              b.agent_identity_placement,
              b.max_identifiers,
              b.media_enabled,
              b.retention_days,
              b.state AS binding_state,
              b.revision AS binding_revision,
              r.name AS rule_set_name,
              r.state AS rule_set_state,
              c.state AS connection_state
              ,c.name AS connection_name
         FROM whatsapp_groups g
         JOIN connections c
           ON c.id = g.connection_id
          AND c.tenant_id = g.tenant_id
    LEFT JOIN group_bindings b
           ON b.whatsapp_group_id = g.id
          AND b.tenant_id = g.tenant_id
    LEFT JOIN rule_sets r
           ON r.id = b.rule_set_id
          AND r.tenant_id = b.tenant_id
        WHERE g.tenant_id = $1
          AND ($2::uuid IS NULL OR (COALESCE(g.wasalx_name,g.display_name),g.id)>(SELECT display_name,id FROM cursor))
          AND ($4::text IS NULL OR position(lower($4) in lower(concat_ws(' ',COALESCE(g.wasalx_name,g.display_name),b.zammad_group_id,r.name)))>0)
          AND ($5::uuid IS NULL OR g.connection_id=$5)
        ORDER BY COALESCE(g.wasalx_name, g.display_name),g.id
        LIMIT $3`,
      [request.principal.tenantId, after ?? null, limit, query || null, connectionId ?? null],
    );
    return this.withActivationReadiness(request.principal.tenantId,rows);
  }

  @Get(":id")
  @Requires("group:read")
  async detail(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    assertUuid(id, "Group ID");
    const result = await this.database.rows<Record<string,unknown>&{id:string}>(
      request.principal.tenantId,
      `SELECT g.id,
              g.connection_id,
              g.external_group_id,
              COALESCE(g.wasalx_name, g.display_name) AS display_name,
              g.display_name AS provider_display_name,
              g.wasalx_name,
              CASE WHEN g.participant_count_known THEN g.participant_count ELSE NULL END AS participant_count,
              g.provider_metadata,
              g.last_synced_at,
              c.provider,
              c.phone_e164,
              c.state AS connection_state,
              (SELECT z.state
                 FROM zammad_instances z
                WHERE z.tenant_id = g.tenant_id) AS zammad_state,
              (SELECT count(*)::integer
                 FROM provider_sessions ps
                WHERE ps.tenant_id = g.tenant_id
                  AND ps.connection_id = g.connection_id
                  AND ps.ownership_state = 'ACTIVE'
                  AND ps.state = 'WORKING') AS working_session_count,
              b.id AS binding_id,
              b.rule_set_id,
              b.zammad_group_id,
              b.default_priority,
              b.assignment_mode,
              b.fixed_owner_id,
              b.sla_policy_id,
              b.business_hours_mode,
              b.business_hours_calendar_id,
              b.acknowledgement_template,
              b.agent_prefix,
              b.agent_identity_placement,
              b.max_identifiers,
              b.media_enabled,
              b.retention_days,
              b.state AS binding_state,
              b.revision AS binding_revision,
              r.name AS rule_set_name,
              r.version AS rule_set_version,
              r.state AS rule_set_state
         FROM whatsapp_groups g
         JOIN connections c
           ON c.id = g.connection_id
          AND c.tenant_id = g.tenant_id
    LEFT JOIN group_bindings b
           ON b.whatsapp_group_id = g.id
          AND b.tenant_id = g.tenant_id
    LEFT JOIN rule_sets r
           ON r.id = b.rule_set_id
          AND r.tenant_id = b.tenant_id
        WHERE g.tenant_id = $1
          AND g.id = $2`,
      [request.principal.tenantId, id],
    );
    if (!result[0]) throw new NotFoundException("WhatsApp group was not found");
    const managed=await this.database.withTenant(request.principal.tenantId,async client=>{
      const received=await loadEffectiveTicketEvent(client,{tenantId:request.principal.tenantId,whatsappGroupId:id,event:"reference_received"});
      const reply=await loadEffectiveTicketEvent(client,{tenantId:request.principal.tenantId,whatsappGroupId:id,event:"before_agent_reply"});
      return{reference_received:received.mode!=="LEGACY",before_agent_reply:reply.mode!=="LEGACY"};
    });
    return {...(await this.withActivationReadiness(request.principal.tenantId,[result[0]]))[0],ticket_events_managed:managed};
  }

  @Post(":id/toggle")
  @Requires("group:write")
  async toggle(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: { enabled?: boolean; expectedRevision?: number },
  ) {
    assertUuid(id, "Group ID");
    if (typeof body.enabled !== "boolean") throw new BadRequestException("enabled is required");
    const key=requireOperationKey(idempotencyKey);
    const expectedRevision=positiveRevision(body.expectedRevision);
    const requestSha256=operationHash({groupId:id,enabled:body.enabled,expectedRevision});
    return this.database.withTenant(request.principal.tenantId, async (client) => withOperationReceipt(
      client,request.principal,"GROUP_BINDING_TOGGLE",key,requestSha256,String(request.id),async()=>{
      const target=(await client.query(
        `SELECT g.id FROM connections c JOIN whatsapp_groups g
           ON g.tenant_id=c.tenant_id AND g.connection_id=c.id
         WHERE g.tenant_id=$1 AND g.id=$2 FOR UPDATE OF c,g`,
        [request.principal.tenantId,id],
      )).rows[0];
      if(!target)throw new BadRequestException("Configured group binding not found");
      const previous = (
        await client.query<{ id: string; state: string; revision: string | number }>(
          `SELECT b.id, b.state, b.revision
             FROM group_bindings b
            WHERE b.tenant_id = $1
              AND b.whatsapp_group_id = $2
              AND b.revision = $3
              FOR UPDATE OF b`,
          [request.principal.tenantId, id, expectedRevision],
        )
      ).rows[0];
      if (!previous) throw new BadRequestException("Configured group binding not found");

      const state = body.enabled ? "ACTIVE" : "PAUSED";
      if (state === "ACTIVE") await this.assertActivationReady(client, request.principal.tenantId, id);
      const result = (
        await client.query<{ id: string; state: string; revision: string | number }>(
          `UPDATE group_bindings
              SET state = $1,
                  updated_at = now()
                  ,revision = revision + 1
            WHERE tenant_id = $2
              AND id = $3
        RETURNING id, state, revision`,
          [state, request.principal.tenantId, previous.id],
        )
      ).rows[0]!;
      await this.recordRevision(client,request,previous.id,Number(result.revision));
      await appendAudit(client, request.principal, {
        action: body.enabled ? "group.activated" : "group.paused",
        targetType: "whatsapp_group",
        targetId: id,
        requestId: request.id,
        previousValue: { state: previous.state },
        newValue: { state, revision: Number(result.revision) },
      });
      return {...result,revision:Number(result.revision)};
    },"Idempotency key was already used for another group state change")).catch(mapGroupDesignationConflict);
  }

  @Put(":id/binding")
  @Requires("group:write")
  async bind(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") idempotencyKey: string | undefined, @Body() body: BindingInput) {
    assertUuid(id, "Group ID");
    const input = validateBinding(body);
    const key=requireOperationKey(idempotencyKey);
    const requestSha256=operationHash({groupId:id,...input});
    return this.database.withTenant(request.principal.tenantId, async (client) => withOperationReceipt(
      client,request.principal,"GROUP_BINDING_SAVE",key,requestSha256,String(request.id),async()=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`ticket-event-config:${request.principal.tenantId}`]);
      const target=(await client.query<{wasalx_name:string|null}>(
        `SELECT g.wasalx_name FROM connections c JOIN whatsapp_groups g
           ON g.tenant_id=c.tenant_id AND g.connection_id=c.id
         WHERE g.tenant_id=$1 AND g.id=$2 FOR UPDATE OF c,g`,
        [request.principal.tenantId,id],
      )).rows[0];
      if(!target)throw new BadRequestException("WhatsApp group was not found");
      const previous =
        (
          await client.query(
            `SELECT b.id,
                    b.rule_set_id,
                    b.zammad_group_id,
                    b.default_priority,
                    b.assignment_mode,
                    b.fixed_owner_id,
                    b.sla_policy_id,
                    b.business_hours_mode,
                    b.business_hours_calendar_id,
                    b.acknowledgement_template,
                    b.agent_prefix,
                    b.agent_identity_placement,
                    b.max_identifiers,
                    b.media_enabled,
                    b.retention_days,
                    b.state,
                    b.revision
               FROM group_bindings b
              WHERE b.tenant_id = $1
                AND b.whatsapp_group_id = $2
              FOR UPDATE OF b`,
            [request.principal.tenantId, id],
          )
        ).rows[0] ?? null;
      if(previous)previous.wasalx_name=target.wasalx_name;

      const previousRevision=previous?.id ? Number(previous.revision) : 0;
      if(previousRevision!==input.expectedRevision)throw new ConflictException("Group configuration changed; refresh before saving it");
      if(previous){
        const changedEvents:Array<"reference_received"|"before_agent_reply">=[];
        if(previous.acknowledgement_template!==input.acknowledgementTemplate)changedEvents.push("reference_received");
        if(previous.agent_prefix!==input.agentPrefix||previous.agent_identity_placement!==input.agentIdentityPlacement)changedEvents.push("before_agent_reply");
        for(const event of changedEvents){
          const selected=await loadEffectiveTicketEvent(client,{tenantId:request.principal.tenantId,whatsappGroupId:id,event});
          if(selected.mode!=="LEGACY")throw new ConflictException("These message settings are managed by ticket workflows in Automation");
        }
      }

      const result = (
        await client.query<{ id: string; state: string; revision: string | number }>(
          `INSERT INTO group_bindings (
             tenant_id, whatsapp_group_id, rule_set_id, zammad_group_id,
             default_priority, assignment_mode, fixed_owner_id, sla_policy_id,
             business_hours_mode, business_hours_calendar_id,
             acknowledgement_template, agent_prefix, agent_identity_placement, max_identifiers,
             media_enabled, retention_days, state
           )
           SELECT $1, g.id, r.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
             FROM whatsapp_groups g
             JOIN rule_sets r
               ON r.id = $2
              AND r.tenant_id = $1
            WHERE g.id = $17
              AND g.tenant_id = $1
           ON CONFLICT (tenant_id, whatsapp_group_id) DO UPDATE
             SET rule_set_id = EXCLUDED.rule_set_id,
                 zammad_group_id = EXCLUDED.zammad_group_id,
                 default_priority = EXCLUDED.default_priority,
                 assignment_mode = EXCLUDED.assignment_mode,
                 fixed_owner_id = EXCLUDED.fixed_owner_id,
                 sla_policy_id = EXCLUDED.sla_policy_id,
                 business_hours_mode = EXCLUDED.business_hours_mode,
                 business_hours_calendar_id = EXCLUDED.business_hours_calendar_id,
                 acknowledgement_template = EXCLUDED.acknowledgement_template,
                 agent_prefix = EXCLUDED.agent_prefix,
                 agent_identity_placement = EXCLUDED.agent_identity_placement,
                 max_identifiers = EXCLUDED.max_identifiers,
                 media_enabled = EXCLUDED.media_enabled,
                 retention_days = EXCLUDED.retention_days,
                 state = EXCLUDED.state,
                 revision = group_bindings.revision + 1,
                 updated_at = now()
        RETURNING id, state, revision`,
          [
            request.principal.tenantId,
            input.ruleSetId,
            input.zammadGroupId,
            input.defaultPriority,
            input.assignmentMode,
            input.fixedOwnerId,
            input.slaPolicyId,
            input.businessHoursMode,
            input.businessHoursCalendarId,
            input.acknowledgementTemplate,
            input.agentPrefix,
            input.agentIdentityPlacement,
            input.maxIdentifiers,
            input.mediaEnabled,
            input.retentionDays,
            input.state,
            id,
          ],
        )
      ).rows[0];
      if (!result) throw new BadRequestException("Group or rule set not found");
      await client.query(
        `UPDATE whatsapp_groups
            SET wasalx_name = $1
          WHERE tenant_id = $2
            AND id = $3`,
        [input.displayName, request.principal.tenantId, id],
      );
      if (input.state === "ACTIVE") await this.assertActivationReady(client, request.principal.tenantId, id);
      await this.recordRevision(client,request,result.id,Number(result.revision));

      await appendAudit(client, request.principal, {
        action: "group.binding_updated",
        targetType: "whatsapp_group",
        targetId: id,
        requestId: request.id,
        previousValue: previous,
        newValue: {
          wasalx_name: input.displayName,
          binding_id: result.id,
          rule_set_id: input.ruleSetId,
          zammad_group_id: input.zammadGroupId,
          default_priority: input.defaultPriority,
          assignment_mode: input.assignmentMode,
          fixed_owner_id: input.fixedOwnerId,
          sla_policy_id: input.slaPolicyId,
          business_hours_mode: input.businessHoursMode,
          business_hours_calendar_id: input.businessHoursCalendarId,
          acknowledgement_template: input.acknowledgementTemplate,
          agent_prefix: input.agentPrefix,
          agent_identity_placement: input.agentIdentityPlacement,
          max_identifiers: input.maxIdentifiers,
          media_enabled: input.mediaEnabled,
          retention_days: input.retentionDays,
          state: result.state,
          revision: Number(result.revision),
        },
      });
      return {...result,revision:Number(result.revision)};
    },"Idempotency key was already used for another group configuration")).catch(mapGroupDesignationConflict);
  }

  private async recordRevision(client:PoolClient,request:AuthenticatedRequest,bindingId:string,revision:number){
    await client.query("SELECT app.record_group_binding_version($1,$2,$3,$4)",[bindingId,revision,request.principal.userId,String(request.id)]);
  }

  private async assertActivationReady(client: PoolClient, tenantId: string, groupId: string) {
    const readiness = await activationReadiness(client, tenantId, groupId);
    const blockers=activationBlockerCodes(readiness);
    if(blockers.length)throw activationBlocked(blockers[0]!);

    const routingBlockers = await this.catalogs.verifySelection(tenantId, {
      zammadGroupId: readiness.zammad_group_id!,
      assignmentMode: readiness.assignment_mode!,
      fixedOwnerId: readiness.fixed_owner_id,
      slaPolicyId: readiness.sla_policy_id,
      businessHoursMode: readiness.business_hours_mode!,
      businessHoursCalendarId: readiness.business_hours_calendar_id,
    });
    if (routingBlockers.length) {
      throw activationBlocked("ZAMMAD_ROUTING_NOT_READY");
    }
  }

  private async withActivationReadiness(tenantId:string,rows:Array<Record<string,unknown>&{id:string}>){
    if(!rows.length)return rows;
    const facts=await this.database.rows<ActivationReadiness>(tenantId,ACTIVATION_READINESS_SQL,[tenantId,rows.map(row=>row.id)]);
    const byGroup=new Map(facts.map(fact=>[fact.group_id,fact]));
    return rows.map(row=>{const fact=byGroup.get(row.id);const codes=fact?activationBlockerCodes(fact):["READINESS_UNAVAILABLE"];return{...row,activation_ready:codes.length===0,activation_blocker_codes:codes}});
  }
}

function validateBinding(body: BindingInput) {
  if (!body.ruleSetId || !body.zammadGroupId || !body.acknowledgementTemplate || !body.agentPrefix) {
    throw new BadRequestException("Rule set, Zammad group, acknowledgement, and agent prefix are required");
  }
  assertUuid(body.ruleSetId, "Rule set ID");
  const defaultPriority = body.defaultPriority ?? "normal";
  const assignmentMode = body.assignmentMode ?? "zammad_auto";
  const state = body.state ?? "DRAFT";
  const maximum = body.maxIdentifiers ?? 20;
  const retention = body.retentionDays ?? 30;
  const fixedOwnerId = cleanOptional(body.fixedOwnerId, 128, "Fixed owner ID");
  const slaPolicyId = cleanOptional(body.slaPolicyId, 128, "SLA policy ID");
  const businessHoursMode = body.businessHoursMode ?? "ALWAYS";
  const agentIdentityPlacement = body.agentIdentityPlacement ?? "HEADER";
  const businessHoursCalendarId = cleanOptional(body.businessHoursCalendarId, 128, "Business-hours calendar ID");
  const zammadGroupId = cleanRequired(body.zammadGroupId, 128, "Zammad group ID");
  const acknowledgementTemplate = cleanRequired(body.acknowledgementTemplate, 1_000, "Acknowledgement template", true);
  const agentPrefix = cleanRequired(body.agentPrefix, 80, "Agent prefix");
  const displayName = cleanOptional(body.displayName, 160, "WasalX group name");

  if (!PRIORITIES.has(defaultPriority)) throw new BadRequestException("Default priority is invalid");
  if (!ASSIGNMENT_MODES.has(assignmentMode)) throw new BadRequestException("Assignment mode is invalid");
  if (!BINDING_STATES.has(state)) throw new BadRequestException("Binding state is invalid");
  if (!BUSINESS_HOURS_MODES.has(businessHoursMode)) throw new BadRequestException("Business-hours mode is invalid");
  if (!AGENT_IDENTITY_PLACEMENTS.has(agentIdentityPlacement)) throw new BadRequestException("Agent identity placement is invalid");
  if (businessHoursMode === "ZAMMAD_CALENDAR" && !businessHoursCalendarId) {
    throw new BadRequestException("A Zammad calendar is required for business-hours routing");
  }
  if (businessHoursMode === "ALWAYS" && businessHoursCalendarId) {
    throw new BadRequestException("A calendar is only valid for Zammad-calendar business hours");
  }
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) {
    throw new BadRequestException("Identifier limit must be an integer between 1 and 100");
  }
  if (!Number.isInteger(retention) || retention < 1 || retention > 3_650) {
    throw new BadRequestException("Retention must be an integer between 1 and 3650 days");
  }
  if (assignmentMode === "fixed_owner" && !fixedOwnerId) {
    throw new BadRequestException("A fixed owner is required for fixed-owner assignment");
  }
  if (fixedOwnerId && !/^[1-9]\d{0,9}$/.test(fixedOwnerId)) {
    throw new BadRequestException("Fixed owner ID must be a positive Zammad user ID");
  }
  if (assignmentMode !== "fixed_owner" && fixedOwnerId) {
    throw new BadRequestException("A fixed owner is only valid for fixed-owner assignment");
  }
  if (!isPositiveZammadId(zammadGroupId)) {
    throw new BadRequestException("Zammad group ID must be a positive numeric ID selected from the workspace catalog");
  }
  if (slaPolicyId && !isPositiveZammadId(slaPolicyId)) {
    throw new BadRequestException("SLA policy ID must be selected from the Zammad workspace catalog");
  }
  if (businessHoursCalendarId && !isPositiveZammadId(businessHoursCalendarId)) {
    throw new BadRequestException("Business-hours calendar ID must be selected from the Zammad workspace catalog");
  }

  return {
    displayName,
    ruleSetId: body.ruleSetId,
    zammadGroupId,
    defaultPriority,
    assignmentMode,
    fixedOwnerId,
    slaPolicyId,
    businessHoursMode,
    businessHoursCalendarId,
    acknowledgementTemplate,
    agentPrefix,
    agentIdentityPlacement,
    maxIdentifiers: maximum,
    mediaEnabled: body.mediaEnabled ?? true,
    retentionDays: retention,
    state,
    expectedRevision: nonNegativeRevision(body.expectedRevision),
  };
}

function positiveRevision(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<1)throw new BadRequestException("expectedRevision must be a positive integer");return Number(value)}
function nonNegativeRevision(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<0)throw new BadRequestException("expectedRevision must be a non-negative integer");return Number(value)}
function boundedListLimit(value:string|undefined,label:string){if(value===undefined)return 200;if(!/^[1-9][0-9]{0,2}$/u.test(value)||Number(value)>200)throw new BadRequestException(`${label} limit is invalid`);return Number(value)}
function operationHash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex")}

function mapGroupDesignationConflict(error:unknown):never{
  if(error&&typeof error==="object"&&"code" in error&&error.code==="23505"
    &&"constraint" in error&&error.constraint==="group_designated_binding_unique"){
    throw new ConflictException({code:"GROUP_BOT_ALREADY_DESIGNATED",message:"Another bot is already active for this group"});
  }
  throw error;
}

async function activationReadiness(client: PoolClient, tenantId: string, groupId: string) {
  const readiness=(await client.query<ActivationReadiness>(ACTIVATION_READINESS_SQL,[tenantId,[groupId]])).rows[0];
  if (!readiness) throw new BadRequestException("Configured group binding not found");
  return readiness;
}

const ACTIVATION_READINESS_SQL=`SELECT g.id AS group_id,b.id AS binding_id,c.provider,c.state AS connection_state,
       g.sync_state,g.last_synced_at,route.state AS webhook_route_state,z.state AS zammad_state,
       r.state AS rule_set_state,b.zammad_group_id,b.assignment_mode,b.fixed_owner_id,b.sla_policy_id,
       b.business_hours_mode,b.business_hours_calendar_id,
       (SELECT count(*) FROM group_bindings designated
         WHERE designated.tenant_id=g.tenant_id AND designated.state='ACTIVE'
           AND designated.routing_provider=c.provider AND designated.routing_group_id=g.external_group_id
           AND designated.whatsapp_group_id<>g.id) AS designated_binding_conflicts,
       (SELECT count(*) FROM trigger_rules rule WHERE rule.tenant_id=r.tenant_id AND rule.rule_set_id=r.id AND rule.enabled) AS enabled_rule_count,
       (SELECT count(*) FROM provider_sessions session WHERE session.tenant_id=c.tenant_id AND session.connection_id=c.id AND session.ownership_state='ACTIVE' AND session.state='WORKING') AS working_session_count,
       (SELECT count(*) FROM connection_operations operation WHERE operation.tenant_id=c.tenant_id AND operation.connection_id=c.id AND operation.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) AS pending_operation_count,
       (SELECT count(*) FROM provider_sessions session JOIN LATERAL app.current_waha_session_runtime(session.id) runtime ON true
         WHERE session.tenant_id=c.tenant_id AND session.connection_id=c.id AND session.ownership_state='ACTIVE' AND session.state='WORKING'
           AND runtime.health_state='HEALTHY' AND runtime.lifecycle_state IN ('ACTIVE','DRAINING')
           AND runtime.last_heartbeat_at>=now()-make_interval(secs=>runtime.heartbeat_ttl_seconds)
           AND session.last_provider_status_at>=runtime.last_started_at
           AND runtime.assignment_lease_expires_at>=now()) AS waha_worker_ready_count
  FROM whatsapp_groups g JOIN connections c ON c.tenant_id=g.tenant_id AND c.id=g.connection_id
  LEFT JOIN group_bindings b ON b.tenant_id=g.tenant_id AND b.whatsapp_group_id=g.id
  LEFT JOIN rule_sets r ON r.tenant_id=b.tenant_id AND r.id=b.rule_set_id
  LEFT JOIN zammad_instances z ON z.tenant_id=g.tenant_id
  LEFT JOIN webhook_routes route ON route.tenant_id=g.tenant_id AND route.connection_id=g.connection_id AND route.provider=c.provider
 WHERE g.tenant_id=$1 AND g.id=ANY($2::uuid[])`;

function activationBlockerCodes(readiness:ActivationReadiness){
  const codes:string[]=[];
  if(Number(readiness.designated_binding_conflicts)>0)codes.push("GROUP_BOT_ALREADY_DESIGNATED");
  if(!readiness.binding_id||!readiness.zammad_group_id||!readiness.assignment_mode||!readiness.business_hours_mode)codes.push("CONFIGURATION_REQUIRED");
  if(readiness.connection_state!=="WORKING")codes.push("CONNECTION_NOT_WORKING");
  if(Number(readiness.pending_operation_count)>0)codes.push("CONNECTION_OPERATION_PENDING");
  if(readiness.webhook_route_state!=="ACTIVE")codes.push("WEBHOOK_ROUTE_NOT_ACTIVE");
  if(Number(readiness.working_session_count)<1)codes.push("PROVIDER_SESSION_NOT_WORKING");
  if(readiness.provider==="WAHA"&&Number(readiness.waha_worker_ready_count)<1)codes.push("WAHA_WORKER_NOT_READY");
  if(readiness.provider==="WAHA"&&(readiness.sync_state!=="ACTIVE"||!readiness.last_synced_at||Date.now()-new Date(readiness.last_synced_at).getTime()>30*60_000))codes.push("GROUP_SYNC_STALE");
  if(readiness.zammad_state!=="WORKING")codes.push("ZAMMAD_NOT_WORKING");
  if(readiness.rule_set_state!=="ACTIVE")codes.push("RULE_SET_NOT_ACTIVE");
  if(Number(readiness.enabled_rule_count)<1)codes.push("NO_ENABLED_RULES");
  return [...new Set(codes)];
}

function activationBlocked(code:string){return new BadRequestException({statusCode:400,code,message:"Group cannot be activated until its live dependencies are ready"})}

function assertUuid(value: string, label: string) {
  if (!UUID.test(value)) throw new BadRequestException(`${label} is invalid`);
}

function cleanRequired(value: string, maximum: number, label: string, allowMultiline = false) {
  const result = value.trim();
  if (!result || result.length > maximum || hasControlCharacters(result, allowMultiline)) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return result;
}

function cleanOptional(value: unknown, maximum: number, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new BadRequestException(`${label} is invalid`);
  return cleanRequired(value, maximum, label);
}

function hasControlCharacters(value: string, allowMultiline: boolean) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (allowMultiline && (code === 9 || code === 10 || code === 13)) return false;
    return code <= 31 || code === 127;
  });
}

function isPositiveZammadId(value: string) {
  return /^[1-9]\d{0,9}$/u.test(value);
}
